"""Vision LLM based drawing dimension detector."""

import base64
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import httpx
from io import BytesIO
from pathlib import Path

from openai import (
    APITimeoutError,
    APIConnectionError,
    APIStatusError,
    BadRequestError,
    OpenAI,
)
from PIL import Image

from .locator import candidate_groups, find_text_groups, group_bbox, refine_bboxes
from .models import BoundingBox, DetectedDimension, DetectionResult
from .parser import create_detected_dimension, normalize_raw_text
from .prompts import EXTRACTION_PROMPT, RETRY_PROMPT, VERIFY_CROP_PROMPT

# Coordinates returned by the model live in this normalized space.
NORM_SPACE = 1000.0

SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}


@dataclass
class _ChannelCfg:
    """Resolved configuration for one LLM channel."""

    num: int
    api_key: str
    base_url: str
    model: str
    extra_body: dict | None
    client: OpenAI | None = field(default=None, repr=False)

    def make_client(self) -> OpenAI:
        """Build (once) the OpenAI client for this channel."""
        if self.client is None:
            self.client = OpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
                # Safety-net defaults only. Every real call overrides these
                # via per-request kwargs in _call_llm (hard caps =
                # CALL_TIMEOUT / CROP_TIMEOUT, no SDK retries); this exists
                # only so that any future call path that forgets to pass
                # timeout cannot hang on the SDK's 10-minute default.
                timeout=httpx.Timeout(60.0),
                max_retries=0,
            )
        return self.client


class DrawingDetector:
    """Detect and extract dimensions from engineering drawings using Vision LLM."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        channel: int = 1,
        verify: bool = True,
    ):
        """
        Initialize the detector.

        Args:
        api_key: API key for the LLM service. If None, reads from
            LLM_{channel}_API_KEY (or legacy LLM_API_KEY) env var.
        base_url: Base URL for the OpenAI-compatible API. If None, reads from
            LLM_{channel}_BASE_URL (or legacy LLM_BASE_URL) env var, defaulting
            to the STG AI server.
        model: Model ID. If None, reads from LLM_{channel}_MODEL (or legacy
            LLM_MODEL) env var.
        verify: When True, dimension locations that look unreliable are
                verified by reading the cropped text region(s) and matching
                them against the extracted text (adds a few cheap calls only
                when needed).

        Failover: OFF by default (the user switches channels manually in the
        UI). When LLM_FAILOVER=1 AND the other channel has an API key
        configured, the detector keeps both channels ready and, per call,
        tries the active channel first, then fails over to the other one on
        timeout / connection error / 429 / 5xx.
        """
        self.verify = verify
        self.channel = channel

        # Resolve the two channel configs (primary = requested, fallback =
        # the other). Each reads LLM_{n}_* env vars with the legacy LLM_*
        # vars (or explicit constructor args) as fallbacks.
        self._channels: list[_ChannelCfg] = []
        for num in (channel, 2 if channel == 1 else 1):
            key_prefix = f"LLM_{num}_"
            is_primary = num == channel
            resolved_key = (
                (api_key if is_primary else None)
                or os.getenv(f"{key_prefix}API_KEY")
                or os.getenv("LLM_API_KEY")
            )
            if not resolved_key:
                if is_primary:
                    raise ValueError(
                        f"API key required. Set {key_prefix}API_KEY (or LLM_API_KEY) "
                        "environment variable, or pass api_key parameter."
                    )
                # No fallback channel configured.
                continue
            resolved_url = (
                (base_url if is_primary else None)
                or os.getenv(f"{key_prefix}BASE_URL")
                or os.getenv("LLM_BASE_URL")
                or "https://llm.stgaiserver.com/v1"
            )
            resolved_model = (
                (model if is_primary else None)
                or os.getenv(f"{key_prefix}MODEL")
                or os.getenv("LLM_MODEL")
                or "/models/qwen3.6-35b-a3b.gguf"
            )
            cfg = _ChannelCfg(
                num=num,
                api_key=resolved_key,
                base_url=resolved_url,
                model=resolved_model,
                extra_body=self._resolve_extra_body(key_prefix),
            )
            self._channels.append(cfg)

        failover_on = os.getenv("LLM_FAILOVER", "0").strip() == "1"
        if not failover_on:
            self._channels = self._channels[:1]

        primary = self._channels[0]
        # Backwards-compatible attributes (cli.py / bench scripts).
        self.api_key = primary.api_key
        self.base_url = primary.base_url
        self.model = primary.model
        self.client = primary.make_client()

        # Channel that answered successfully most recently. Every call tries
        # this one first; on failure it fails over and this moves along.
        self._active_num = channel
        self._deadline: float | None = None
        self._switch_lock = threading.Lock()
        self._crop_skip_logged = False

    @staticmethod
    def _resolve_extra_body(key_prefix: str) -> dict | None:
        """Per-channel extra request body.

        Defaults to disabling thinking on BOTH field names because the two
        endpoints disagree: the STG server honors ``enable_reasoning`` and
        ignores ``enable_thinking``, while DashScope (Aliyun) ignores
        ``enable_reasoning`` and honors ``enable_thinking``. Sending both is
        accepted by both, and each server switches reasoning off.

        Override per channel with e.g. LLM_2_EXTRA_BODY={"enable_thinking":
        false}; set it to an empty object to send nothing extra.
        """
        raw = os.getenv(f"{key_prefix}EXTRA_BODY")
        if raw is not None:
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return {"enable_reasoning": False, "enable_thinking": False}
        return {"enable_reasoning": False, "enable_thinking": False}

    def _load_image_as_base64(self, image_path: str | Path) -> str:
        """Load an image file and encode as base64."""
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"Image not found: {image_path}")

        with open(image_path, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")

    def _get_image_media_type(self, image_path: str | Path) -> str:
        """Get the media type based on file extension."""
        suffix = Path(image_path).suffix.lower()
        media_types = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".bmp": "image/bmp",
            ".tif": "image/tiff",
            ".tiff": "image/tiff",
        }
        return media_types.get(suffix, "image/png")

    def _get_image_dimensions(self, image_path: str | Path) -> tuple[int, int]:
        """Get image dimensions (width, height)."""
        with Image.open(image_path) as img:
            return img.size  # (width, height)

    def detect(self, image_path: str | Path) -> DetectionResult:
        """
        Detect dimensions in an engineering drawing.

        Args:
            image_path: Path to the image file.

        Returns:
            DetectionResult with all detected dimensions.
        """
        image_path = Path(image_path)
        image_width, image_height = self._get_image_dimensions(image_path)
        image_b64 = self._load_image_as_base64(image_path)
        media_type = self._get_image_media_type(image_path)

        # Budget the TOTAL LLM wall time for this detection. Without a
        # deadline, a run made of several slow-but-under-cap calls (probe +
        # extract + retry + up to 10 crop reads) can exceed the Node-side
        # exec timeout, which then kills the process with a generic error.
        # With the deadline, the worst case exits Python-side with a clear
        # message instead.
        self._deadline = time.monotonic() + self.TOTAL_LLM_BUDGET

        # Fail fast if the selected channel is unreachable / misconfigured,
        # so the UI gets immediate feedback instead of hanging until timeout.
        self._probe_channel()

        content = self._call_llm(image_b64, media_type, label="extract")
        raw_items = self._parse_response(content)
        if not raw_items or not any(self._has_bbox(item) for item in raw_items):
            # Empty, or the model omitted every bounding box: retry once
            content = self._call_llm(
                image_b64, media_type, retry=True, label="extract-retry"
            )
            retried_items = self._parse_response(content)
            if any(self._has_bbox(item) for item in retried_items):
                raw_items = retried_items

        # Normalize raw text and de-duplicate (LLMs often emit near-duplicates)
        seen: set[str] = set()
        unique_items = []
        for item in raw_items:
            norm = normalize_raw_text(item.get("raw_text", ""))
            if not norm or norm.lower() in seen:
                continue
            seen.add(norm.lower())
            unique_items.append(item)

        # Map normalized (0-1000) coordinates back to pixels; support models
        # that return pixel coordinates directly (any coord > 1000 => pixels).
        for item in unique_items:
            self._scale_bbox(item, image_width, image_height)

        dimensions = [
            create_detected_dimension(item_id=f"dim_{i:03d}", raw_data=item)
            for i, item in enumerate(unique_items, 1)
        ]

        # Refine bounding boxes against actual text pixels found by CV.
        groups = find_text_groups(image_path)
        original_bboxes = [d.bbox for d in dimensions]
        refined_list = refine_bboxes(
            [d.bbox for d in dimensions], groups, image_width, image_height
        )
        for dim, (refined, found) in zip(dimensions, refined_list):
            if found:
                dim.bbox = refined
            else:
                # LLM pointed at a location with no text: downgrade confidence
                dim.confidence = min(dim.confidence, 0.45)
                dim.needs_review = True

        if self.verify and groups:
            self._verify_locations(dimensions, groups, image_path, original_bboxes)

        return DetectionResult(
            image_path=str(image_path),
            image_width=image_width,
            image_height=image_height,
            dimensions=dimensions,
            total_detected=len(dimensions),
            needs_review_count=sum(1 for d in dimensions if d.needs_review),
        )

    # ------------------------------------------------------------------ #
    # Probe attempt(s) before every detection; a hard 5s socket timeout each.
    # If the active channel fails, the fallback channel is probed too; only
    # if both fail does detection abort with "当前LLM通道不可用" — the real
    # call is NOT attempted.
    PROBE_TIMEOUT = 5.0
    # Hard wall-clock cap for EVERY individual LLM call (extraction, retry,
    # crop verification). The probe has already proven a channel answers;
    # if a real call still exceeds this budget we abort immediately with a
    # clear message so the user can retry instead of hanging for minutes.
    CALL_TIMEOUT = 45.0
    # Crop-read calls are tiny (a small crop + max 60 tokens out). They get
    # a much tighter cap so a slow channel cannot burn the total budget on
    # location verification.
    CROP_TIMEOUT = 15.0
    # Total LLM wall-time budget per detection run. The Node route's exec
    # timeout (360s) must stay above this + CV/startup overhead (~60s).
    TOTAL_LLM_BUDGET = 240.0

    def _remaining(self) -> float:
        """Seconds left in the total LLM budget (negative => exhausted)."""
        if self._deadline is None:
            return self.TOTAL_LLM_BUDGET
        return self._deadline - time.monotonic()

    def _active_cfg(self) -> _ChannelCfg:
        """Channel config currently marked as responsive."""
        for cfg in self._channels:
            if cfg.num == self._active_num:
                return cfg
        return self._channels[0]

    def _mark_active(self, cfg: _ChannelCfg) -> None:
        with self._switch_lock:
            self._active_num = cfg.num

    def _probe_channel(self) -> None:
        """Fail fast with a clear message if no LLM channel is usable.

        A minimal OpenAI-SDK call (max_tokens=5, temperature=0) is issued
        before the real detection. The active channel is probed first; on
        timeout / connection failure the fallback channel is probed too.
        - A probe answers (any status): that channel becomes active and the
          real call proceeds on it.
        - A probe returns HTTP 4xx (401/404/...): channel is misconfigured —
          raise RuntimeError immediately, no point attempting the real call.
        - Both probes time out / fail to connect: raise RuntimeError
          "当前LLM通道不可用" and abort — the real call is NOT attempted.
        """
        last_err: Exception | None = None
        for cfg in self._channels:
            budget = self._remaining()
            if budget <= 0:
                raise RuntimeError(
                    "LLM 总耗时超出预算，检测已中止。请稍后重试。"
                )
            try:
                kwargs: dict = dict(
                    model=cfg.model,
                    # Probe message: model just needs to answer anything
                    # within the timeout — the goal is exercising the full
                    # link, not the reply content.
                    messages=[{"role": "user", "content": "我说ping，你说pong"}],
                    # Small but not 1: some gateways/models behave oddly with
                    # a 1-token cap, and 5 tokens is still negligible.
                    max_tokens=5,
                    temperature=0.0,
                    timeout=min(self.PROBE_TIMEOUT, budget),
                )
                if cfg.extra_body is not None:
                    kwargs["extra_body"] = cfg.extra_body
                resp = cfg.make_client().chat.completions.create(**kwargs)
                self._mark_active(cfg)
                return
            except APITimeoutError as e:
                # Note: APITimeoutError subclasses APIConnectionError, so
                # this clause must come first.
                last_err = e
            except APIConnectionError as e:
                last_err = e
            except APIStatusError as e:
                # A non-2xx status (e.g. 401/404) means the channel is
                # misconfigured — retrying cannot help.
                raise RuntimeError(
                    f"LLM 通道 {cfg.num} 返回错误（{cfg.base_url}）："
                    f"HTTP {e.status_code}"
                ) from e
        tried = "、".join(str(c.num) for c in self._channels)
        raise RuntimeError(
            f"当前LLM通道不可用（通道 {tried} 探针 {self.PROBE_TIMEOUT:.0f}s 超时）"
        ) from last_err

    def _call_llm(
        self,
        image_b64: str,
        media_type: str,
        retry: bool = False,
        prompt: str | None = None,
        json_mode: bool = False,
        max_tokens: int = 4096,
        label: str = "extract",
        timeout: float | None = None,
    ) -> str:
        """Call the vision LLM and return the complete text in ONE request.

        Non-streamed by design: the probe (_probe_channel) has already
        verified a channel responds, so there is no need to hold a streaming
        connection open. Every attempt is hard-capped (CALL_TIMEOUT for the
        extraction, CROP_TIMEOUT for crop reads) with NO SDK-level retries;
        on timeout/connection/5xx/429 the call fails over to the other
        configured channel ONCE and retries there. 4xx (misconfiguration) is
        never retried on the same channel. All attempts are also bounded by
        the per-run total LLM budget (TOTAL_LLM_BUDGET).
        """
        per_attempt = timeout or self.CALL_TIMEOUT
        prompt = prompt or (RETRY_PROMPT if retry else EXTRACTION_PROMPT)
        messages = [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{media_type};base64,{image_b64}"},
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ]
        kwargs: dict = dict(
            model=None,  # set per channel below
            messages=messages,
            temperature=0.0,  # deterministic extraction
            max_tokens=max_tokens,
            # Single-shot, non-streamed request with a hard per-attempt cap.
            # No SDK retries (retry policy lives on the client —
            # max_retries=0 — because the OpenAI SDK does not accept
            # max_retries as a per-request kwarg).
        )

        def _create_once(cfg: _ChannelCfg, budget: float) -> str:
            t0 = time.time()
            call_kwargs = dict(kwargs, model=cfg.model, timeout=budget)
            if cfg.extra_body is not None:
                call_kwargs["extra_body"] = cfg.extra_body
            try:
                resp = cfg.make_client().chat.completions.create(**call_kwargs)
            except BadRequestError:
                # Some OpenAI-compatible servers reject unknown extra_body
                # fields with a 400. Retry the SAME channel once without the
                # extra body (it may just mean thinking stays on — slower,
                # but usable). This is deliberately NOT done for
                # timeout/connection errors: those already fail over below,
                # and a silent same-channel retry would double wall time.
                if cfg.extra_body is None:
                    raise
                resp = cfg.make_client().chat.completions.create(
                    **dict(kwargs, model=cfg.model, timeout=budget)
                )
            dur = time.time() - t0
            usage = getattr(resp, "usage", None)
            print(
                f"[llm] ch{cfg.num} {label}: {dur:.1f}s, "
                f"prompt_tokens={getattr(usage, 'prompt_tokens', '?')}, "
                f"completion_tokens={getattr(usage, 'completion_tokens', '?')}",
                file=sys.stderr,
            )
            if not resp.choices:
                return ""
            return resp.choices[0].message.content or ""

        if json_mode:
            try:
                return self._attempt_with_failover(
                    _create_once, kwargs, per_attempt, json_mode=True
                )
            except BadRequestError:
                # Some OpenAI-compatible servers reject response_format with
                # a 400. ONLY fall back on that specific rejection: retrying
                # the entire image call on timeouts/connection errors here
                # used to silently DOUBLE the wall time on slow channels.
                return self._attempt_with_failover(
                    _create_once, kwargs, per_attempt, json_mode=False
                )
        return self._attempt_with_failover(
            _create_once, kwargs, per_attempt, json_mode=False
        )

    def _attempt_with_failover(
        self,
        create_once,
        kwargs: dict,
        per_attempt: float,
        json_mode: bool = False,
    ) -> str:
        """Run one logical LLM call across up to two channels.

        The active channel goes first; on timeout / connection failure /
        429 / 5xx the other channel (if configured) gets the remaining
        budget. A success marks that channel active for the next call, so a
        slow channel is abandoned for the rest of the run.
        """
        if json_mode:
            kwargs = {**kwargs, "response_format": {"type": "json_object"}}
        order = [self._active_cfg()] + [
            c for c in self._channels if c.num != self._active_num
        ]
        tried: list[int] = []
        last_err: Exception | None = None
        for cfg in order:
            budget = self._remaining()
            if budget <= 0:
                raise RuntimeError(
                    "LLM 总耗时超出预算（240 秒），检测已中止。请稍后重试。"
                )
            attempt_budget = min(per_attempt, budget)
            tried.append(cfg.num)
            try:
                out = create_once(cfg, attempt_budget)
                self._mark_active(cfg)
                return out
            except APITimeoutError as e:
                # Note: APITimeoutError subclasses APIConnectionError — this
                # clause must come first.
                last_err = e
            except APIConnectionError as e:
                last_err = e
            except APIStatusError as e:
                if e.status_code == 429 or e.status_code >= 500:
                    # Transient: worth failing over to the other channel.
                    last_err = e
                else:
                    raise RuntimeError(
                        f"LLM 通道 {cfg.num} 返回错误（{cfg.base_url}）："
                        f"HTTP {e.status_code}"
                    ) from e
        names = "、".join(str(n) for n in tried)
        raise RuntimeError(
            f"LLM 调用超时（通道 {names} 均未在 {per_attempt:.0f} 秒内响应），"
            "已中止。请直接重试。"
        ) from last_err

    # ------------------------------------------------------------------ #
    # Location verification: read the cropped text region of every matched
    # box and confirm it holds the extracted text. Catches displaced boxes
    # and swapped parallel dimensions that distance-based matching cannot.
    VERIFY_MAX_CROPS = 4
    # Hard cap on TOTAL crop-read LLM calls per detection. The global
    # fallback below used to scan EVERY text group, firing dozens of calls
    # on busy drawings; that burst trips gateway per-minute quotas and the
    # NEXT detection then hangs until its 45s timeout ("first image works,
    # second always times out"). Extra reads beyond this cap are skipped:
    # those dimensions just keep needs_review=True.
    VERIFY_MAX_TOTAL_READS = 10

    def _verify_locations(
        self,
        dimensions: list[DetectedDimension],
        groups: list,
        image_path: str | Path,
        original_bboxes: list[BoundingBox] | None = None,
    ) -> None:
        """Verify EVERY dim location by reading the text at its matched text
        region (and nearby candidates) and comparing against raw_text.

        Reads are cached per text group, so the cost is roughly one cheap
        crop-read per text annotation in the drawing, not per dimension.
        """
        img = Image.open(image_path).convert("RGB")
        read_cache: dict[int, str] = {}
        reads_done = 0

        def read_group(gi: int) -> str:
            nonlocal reads_done
            if gi not in read_cache:
                if reads_done >= self.VERIFY_MAX_TOTAL_READS:
                    # Budget exhausted: treat as unreadable instead of
                    # firing yet another LLM call.
                    read_cache[gi] = ""
                    return ""
                b = group_bbox(groups[gi], img.width, img.height)
                crop = img.crop(
                    (
                        max(0, int(b.top_left_x) - 10),
                        max(0, int(b.top_left_y) - 10),
                        min(img.width, int(b.bottom_right_x) + 10),
                        min(img.height, int(b.bottom_right_y) + 10),
                    )
                )
                if crop.width < 4 or crop.height < 4:
                    read_cache[gi] = ""
                else:
                    read_cache[gi] = self._read_crop(crop)
                    reads_done += 1
            return read_cache[gi]

        def nearest_group(refined_bbox: BoundingBox) -> int | None:
            """Which text group does the refined bbox currently cover?"""
            best, best_gi = 1e9, None
            for gi, g in enumerate(groups):
                d = (g.center[0] - refined_bbox.center[0]) ** 2 + (
                    g.center[1] - refined_bbox.center[1]
                ) ** 2
                if d < best:
                    best, best_gi = d, gi
            return best_gi if best_gi is not None and best ** 0.5 <= 30 else None

        # Prefetch the likely-needed crop reads CONCURRENTLY for all
        # channels, then let the matching logic below run against a warm
        # cache. Bounded by VERIFY_MAX_TOTAL_READS.
        wanted: list[int] = []
        seen_wanted: set[int] = set()

        def note(gi: int | None) -> None:
            if gi is not None and gi not in read_cache and gi not in seen_wanted:
                seen_wanted.add(gi)
                wanted.append(gi)

        for dim, orig_bbox in zip(
            dimensions, original_bboxes or [d.bbox for d in dimensions]
        ):
            if not normalize_raw_text(dim.raw_text).lower():
                continue
            if orig_bbox.width <= 0 and orig_bbox.height <= 0:
                cands = sorted(
                    ((0.0, gi) for gi in range(len(groups))),
                    key=lambda t: (groups[t[1]].center[1], groups[t[1]].center[0]),
                )
            else:
                cands = candidate_groups(orig_bbox, groups)
                note(nearest_group(dim.bbox))
            for _, gi in cands[: self.VERIFY_MAX_CROPS]:
                note(gi)

        take = wanted[: max(0, self.VERIFY_MAX_TOTAL_READS - reads_done)]
        if take:
            def _read_one(gi: int) -> tuple[int, str]:
                b = group_bbox(groups[gi], img.width, img.height)
                crop = img.crop(
                    (
                        max(0, int(b.top_left_x) - 10),
                        max(0, int(b.top_left_y) - 10),
                        min(img.width, int(b.bottom_right_x) + 10),
                        min(img.height, int(b.bottom_right_y) + 10),
                    )
                )
                if crop.width < 4 or crop.height < 4:
                    return gi, ""
                return gi, self._read_crop(crop)

            # Up to 4 concurrent crop reads: the reads are cached and each
            # is a tiny call, so 4 workers is plenty. (8 used to burst-fire
            # small requests at the gateway, which trips per-second quotas
            # on throttled endpoints like DashScope personal keys.)
            with ThreadPoolExecutor(max_workers=min(4, len(take))) as ex:
                for gi, text in ex.map(_read_one, take):
                    read_cache[gi] = text
                    reads_done += 1

        for dim, orig_bbox in zip(
            dimensions, original_bboxes or [dim.bbox for dim in dimensions]
        ):
            degenerate = orig_bbox.width <= 0 and orig_bbox.height <= 0
            if degenerate:
                cands = sorted(
                    ((0.0, gi) for gi in range(len(groups))),
                    key=lambda t: (groups[t[1]].center[1], groups[t[1]].center[0]),
                )
            else:
                cands = candidate_groups(orig_bbox, groups)
                # Always include the group the box currently covers
                current = nearest_group(dim.bbox)
                if current is not None and current not in {gi for _, gi in cands}:
                    cands.append((0.0, current))
                    cands.sort(key=lambda t: (t[0], t[1]))
            target = normalize_raw_text(dim.raw_text).lower()
            if not target:
                continue
            matched = False
            local_checked: set[int] = set()
            # 1) Local candidates: groups near the LLM/provisional location
            for dist, gi in cands[: self.VERIFY_MAX_CROPS]:
                local_checked.add(gi)
                read = read_group(gi)
                if read and self._texts_match(read, dim.raw_text):
                    dim.bbox = group_bbox(groups[gi], img.width, img.height)
                    dim.confidence = min(0.9, dim.confidence + 0.1)
                    dim.needs_review = False
                    matched = True
                    break
            # 2) Global fallback: the LLM sometimes misplaces a dimension's
            #    bbox entirely (e.g. onto a title-block caption). If no local
            #    group holds this text, scan ALL text groups for one that
            #    does. Reads are cached per group, so extra groups cost one
            #    cheap crop-read each. Matching is strict (normalized
            #    equality), so this cannot relocate to unrelated text.
            if not matched:
                for gi in range(len(groups)):
                    if gi in local_checked:
                        continue
                    read = read_group(gi)
                    if read and self._texts_match(read, dim.raw_text):
                        dim.bbox = group_bbox(groups[gi], img.width, img.height)
                        dim.confidence = min(0.9, dim.confidence + 0.1)
                        dim.needs_review = False
                        matched = True
                        break
            if not matched:
                # Could not confirm any candidate location holds this text
                dim.confidence = min(dim.confidence, 0.5)
                dim.needs_review = True

    @staticmethod
    def _texts_match(read_text: str, raw_text: str) -> bool:
        """True if a cropped region's text corresponds to a dimension text.

        Requires normalized equality, plus a few strict, targeted variants:
        - a trailing unit may be present on either side ("10 ±0.05" vs
          "10 ±0.05 mm");
        - the dimension may carry a quantity prefix the region read lacks
          ("2XΦ12" vs "Φ12").

        This deliberately does NOT do fuzzy/substring matching: the crop
        reader occasionally paraphrases, and a loose match could relocate a
        dimension onto unrelated text.
        """

        def norm(s: str) -> str:
            return normalize_raw_text(s).lower().strip()

        a, b = norm(read_text), norm(raw_text)
        if not a or not b:
            return False
        if a == b:
            return True
        unit_re = re.compile(r"\s*(mm|inch|in|inches|degree|deg|°)$")
        for x, y in ((a, b), (b, a)):
            m = unit_re.search(x)
            if m and x[: m.start()] == y:
                return True
        qty = re.match(r"^\d+[x×]\s*(.*)$", b)
        if qty and qty.group(1).strip() == a:
            return True
        return False

    def _read_crop(self, crop: Image.Image) -> str:
        """Ask the LLM what text is printed in a cropped image region.

        Non-fatal by design: crop reads only refine box locations. If the
        channels are slow/throttled at this point (or the run's LLM budget
        is exhausted), returning "" just leaves the dimension flagged
        needs_review — a good extraction is never thrown away because a
        verification read failed.
        """
        buf = BytesIO()
        crop.save(buf, "PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        try:
            content = self._call_llm(
                b64,
                "image/png",
                prompt=VERIFY_CROP_PROMPT,
                json_mode=False,
                max_tokens=60,
                label="crop-read",
                timeout=self.CROP_TIMEOUT,
            )
        except RuntimeError as e:
            # Timeout / budget-exhausted / 4xx on both channels: treat the
            # crop as unreadable instead of failing the whole detection.
            # Log once per run — the global fallback can otherwise print
            # one line per text group when the budget is gone.
            if not self._crop_skip_logged:
                print(f"[llm] crop-read skipped: {e}", file=sys.stderr)
                self._crop_skip_logged = True
            return ""
        text = content.strip().strip('"\'`')
        if text.upper() == "EMPTY":
            return ""
        return text

    @staticmethod
    def _has_bbox(item: dict) -> bool:
        """True if the item carries usable bounding box coordinates."""
        tl = item.get("bbox_top_left")
        br = item.get("bbox_bottom_right")
        try:
            return (
                len(tl) == 2
                and len(br) == 2
                and (float(tl[0]), float(tl[1]), float(br[0]), float(br[1])) != (0.0, 0.0, 0.0, 0.0)
            )
        except (TypeError, ValueError):
            return False

    def _parse_response(self, content: str) -> list[dict]:
        """Parse the LLM response into a list of raw dimension dicts."""
        json_str = self._extract_json_text(content)
        if json_str is None:
            return []
        try:
            raw_data = json.loads(json_str)
        except json.JSONDecodeError:
            # Last resort: find the first JSON array in the response
            match = re.search(r"\[.*\]", content, re.DOTALL)
            if not match:
                return []
            try:
                raw_data = json.loads(match.group())
            except json.JSONDecodeError:
                return []
        if not isinstance(raw_data, list):
            return []
        return [item for item in raw_data if isinstance(item, dict)]

    @staticmethod
    def _extract_json_text(content: str) -> str | None:
        """Strip markdown fences / prose and return the JSON portion."""
        text = content.strip()
        if text.startswith("```"):
            # Extract content between the first ``` and the last ```
            start = text.find("\n")
            end = text.rfind("```")
            if end > start:
                return text[start + 1:end].strip()
            return None
        # If it starts with a JSON array/object, take it; otherwise scan
        if text.startswith(("[", "{")):
            return text
        match = re.search(r"(\[.*\]|\{.*\})", text, re.DOTALL)
        return match.group(1) if match else None

    @staticmethod
    def _scale_bbox(item: dict, image_width: int, image_height: int) -> None:
        """Convert normalized 0-1000 bbox coords to pixel coords."""
        tl = item.get("bbox_top_left") or [0, 0]
        br = item.get("bbox_bottom_right") or [0, 0]
        try:
            x1, y1 = float(tl[0]), float(tl[1])
            x2, y2 = float(br[0]), float(br[1])
        except (TypeError, ValueError, IndexError):
            item["bbox_top_left"] = [0.0, 0.0]
            item["bbox_bottom_right"] = [0.0, 0.0]
            return

        coords = [x1, y1, x2, y2]
        if max(coords) <= NORM_SPACE and min(coords) >= 0:
            # normalized space -> pixels
            x1, x2 = x1 * image_width / NORM_SPACE, x2 * image_width / NORM_SPACE
            y1, y2 = y1 * image_height / NORM_SPACE, y2 * image_height / NORM_SPACE
        # else: already in pixel space

        # Clamp to image bounds and normalize orientation
        item["bbox_top_left"] = [
            round(max(0.0, min(x1, x2)), 1),
            round(max(0.0, min(y1, y2)), 1),
        ]
        item["bbox_bottom_right"] = [
            round(min(image_width, max(x1, x2)), 1),
            round(min(image_height, max(y1, y2)), 1),
        ]
