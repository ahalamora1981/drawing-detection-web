"""Vision LLM based drawing dimension detector."""

import base64
import json
import os
import re
from io import BytesIO
from pathlib import Path

from openai import OpenAI
from PIL import Image

from .locator import candidate_groups, find_text_groups, group_bbox, refine_bboxes
from .models import BoundingBox, DetectedDimension, DetectionResult
from .parser import create_detected_dimension, normalize_raw_text
from .prompts import EXTRACTION_PROMPT, RETRY_PROMPT, VERIFY_CROP_PROMPT

# Coordinates returned by the model live in this normalized space.
NORM_SPACE = 1000.0

SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}


class DrawingDetector:
    """Detect and extract dimensions from engineering drawings using Vision LLM."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout: float = 180.0,
        verify: bool = True,
    ):
        """
        Initialize the detector.

        Args:
            api_key: API key for the LLM service. If None, reads from LLM_API_KEY env var.
            base_url: Base URL for the OpenAI-compatible API. If None, reads from
                LLM_BASE_URL env var, defaulting to the STG AI server.
            model: Model ID. If None, reads from LLM_MODEL env var.
            timeout: Request timeout in seconds.
            verify: When True, dimension locations that look unreliable are
                verified by reading the cropped text region(s) and matching
                them against the extracted text (adds a few cheap calls only
                when needed).
        """
        self.api_key = api_key or os.getenv("LLM_API_KEY")
        if not self.api_key:
            raise ValueError(
                "API key required. Set LLM_API_KEY environment variable or pass api_key parameter."
            )

        self.base_url = base_url or os.getenv("LLM_BASE_URL") or "https://llm.stgaiserver.com/v1"
        self.model = model or os.getenv("LLM_MODEL") or "/models/qwen3.6-35b-a3b.gguf"
        self.verify = verify

        self.client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=timeout,
            max_retries=1,
        )

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

        content = self._call_llm(image_b64, media_type)
        raw_items = self._parse_response(content)
        if not raw_items or not any(self._has_bbox(item) for item in raw_items):
            # Empty, or the model omitted every bounding box: retry once
            content = self._call_llm(image_b64, media_type, retry=True)
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
    def _call_llm(
        self,
        image_b64: str,
        media_type: str,
        retry: bool = False,
        prompt: str | None = None,
        json_mode: bool = True,
        max_tokens: int = 4096,
    ) -> str:
        """Call the vision LLM, preferring JSON mode with graceful fallback."""
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
            model=self.model,
            messages=messages,
            temperature=0.0,  # deterministic extraction
            max_tokens=max_tokens,
        )
        if json_mode:
            try:
                response = self.client.chat.completions.create(
                    **kwargs, response_format={"type": "json_object"}
                )
            except Exception:
                # Some OpenAI-compatible servers reject response_format
                response = self.client.chat.completions.create(**kwargs)
        else:
            response = self.client.chat.completions.create(**kwargs)
        return response.choices[0].message.content or ""

    # ------------------------------------------------------------------ #
    # Location verification: read the cropped text region of every matched
    # box and confirm it holds the extracted text. Catches displaced boxes
    # and swapped parallel dimensions that distance-based matching cannot.
    VERIFY_MAX_CROPS = 4

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

        def read_group(gi: int) -> str:
            if gi not in read_cache:
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
        """Ask the LLM what text is printed in a cropped image region."""
        buf = BytesIO()
        crop.save(buf, "PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        content = self._call_llm(
            b64,
            "image/png",
            prompt=VERIFY_CROP_PROMPT,
            json_mode=False,
            max_tokens=60,
        )
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
