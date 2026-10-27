#!/usr/bin/env python3
"""Two-stage detection CLI used by the web app.

Stage 1 — ``locate``
    Find WHERE the annotations are. Returns boxes only: no text, no numbers,
    no dimension type, no colour. The user reviews/edits these boxes in the
    browser before stage 2 runs.

Stage 2 — ``read``
    Read the text inside each user-confirmed box, then parse it into
    structured values (nominal, tolerance, unit, dimension type, feature) and
    render the annotated export image.

Both stages write their artefacts into ``--out`` so the Next.js side can poll
progress and serve the result without holding a long HTTP request open.

Usage:
    python -m drawing_detection.stage_cli locate \
        --image drawing.png --out run-dir --channel 2 \
        --config '{"scope":"dimensions","density":"standard"}'

    python -m drawing_detection.stage_cli read \
        --image drawing.png --out run-dir --channel 2 --boxes-file boxes.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

from PIL import Image

from .detector import NORM_SPACE, DrawingDetector
from .locator import find_text_groups, refine_bboxes
from .models import (
    BoundingBox,
    DetectionResult,
    DimensionType,
    FeatureClassification,
    Unit,
)
from .parser import create_detected_dimension, normalize_raw_text
from .prompts import LOCATE_RETRY_PROMPT, VERIFY_CROP_PROMPT, build_locate_prompt
from .visualizer import draw_bounding_boxes

# Locating is one whole-image call, so it needs much less budget than a full
# extraction run; reading is one small call per box.
LOCATE_BUDGET = 150.0
READ_BUDGET = 240.0
MAX_BOXES = 60
MIN_BOX_PX = 8.0
# Dimension annotations are never as narrow as a single letter; this drops
# section markers ("A") that the model mistakes for annotations.
MIN_BOX_WIDTH = 14.0


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _atomic_write_json(path: Path, data: object) -> None:
    """Write JSON atomically so a poller never reads a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


def _iou(a: dict, b: dict) -> float:
    ax1, ay1, ax2, ay2 = a["x"], a["y"], a["x"] + a["w"], a["y"] + a["h"]
    bx1, by1, bx2, by2 = b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def _raw_boxes(items: list[dict]) -> list[dict]:
    """Extract {x1,y1,x2,y2} pixel boxes from the model's JSON items."""
    out: list[dict] = []
    for item in items:
        tl = item.get("bbox_top_left") or item.get("top_left")
        br = item.get("bbox_bottom_right") or item.get("bottom_right")
        if not (isinstance(tl, (list, tuple)) and isinstance(br, (list, tuple))):
            # Tolerate [x, y, w, h] or {x, y, w, h}
            if isinstance(item.get("bbox"), (list, tuple)) and len(item["bbox"]) == 4:
                x, y, w, h = (float(v) for v in item["bbox"])
                tl, br = [x, y], [x + w, y + h]
            else:
                continue
        try:
            x1, y1, x2, y2 = float(tl[0]), float(tl[1]), float(br[0]), float(br[1])
        except (TypeError, ValueError, IndexError):
            continue
        out.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2})
    return out


def _to_pixels(box: dict, width: int, height: int) -> dict:
    """Scale a normalized (0-1000) box to pixels; pass pixels through."""
    x1, y1, x2, y2 = box["x1"], box["y1"], box["x2"], box["y2"]
    if max(x1, y1, x2, y2) <= NORM_SPACE and min(x1, y1, x2, y2) >= 0:
        x1, x2 = x1 * width / NORM_SPACE, x2 * width / NORM_SPACE
        y1, y2 = y1 * height / NORM_SPACE, y2 * height / NORM_SPACE
    x1, x2 = max(0.0, min(x1, x2)), min(float(width), max(x1, x2))
    y1, y2 = max(0.0, min(y1, y2)), min(float(height), max(y1, y2))
    return {"x1": x1, "y1": y1, "x2": x2, "y2": y2}


def _dedupe(boxes: list[dict], threshold: float = 0.6) -> list[dict]:
    """Drop near-duplicate boxes, keeping the first (model order) one."""
    kept: list[dict] = []
    for box in boxes:
        if any(_iou(box, other) >= threshold for other in kept):
            continue
        kept.append(box)
    return kept


def _read_progress(path: Path, data: dict) -> None:
    _atomic_write_json(path, data)


# --------------------------------------------------------------------------- #
# Stage 1 — locate
# --------------------------------------------------------------------------- #

def cmd_locate(args: argparse.Namespace) -> int:
    image = Path(args.image)
    out = Path(args.out)
    config = json.loads(args.config) if args.config else {}
    density = str(config.get("density", "standard")).lower()
    max_boxes = int(config.get("max_boxes") or MAX_BOXES)

    detector = DrawingDetector(channel=args.channel)
    detector._deadline = time.monotonic() + LOCATE_BUDGET
    t0 = time.time()

    width, height = detector._get_image_dimensions(image)
    image_b64 = detector._load_image_as_base64(image)
    media_type = detector._get_image_media_type(image)

    detector._probe_channel()

    prompt = build_locate_prompt(config)
    content = detector._call_llm(
        image_b64,
        media_type,
        prompt=prompt,
        json_mode=True,
        max_tokens=2048,
        label="locate",
    )
    items = detector._parse_response(content)
    boxes = _raw_boxes(items)
    if not boxes:
        _log("[locate] empty response, retrying once")
        content = detector._call_llm(
            image_b64,
            media_type,
            prompt=LOCATE_RETRY_PROMPT,
            json_mode=True,
            max_tokens=2048,
            label="locate-retry",
        )
        boxes = _raw_boxes(detector._parse_response(content))

    boxes = [_to_pixels(b, width, height) for b in boxes]

    # Snap boxes to real text pixels: the model's box is an estimate, the
    # printed text is ground truth. This is what makes stage-1 boxes tight
    # enough for stage 2 to crop.
    groups = find_text_groups(image)
    refined = refine_bboxes(
        [BoundingBox(top_left_x=b["x1"], top_left_y=b["y1"],
                     bottom_right_x=b["x2"], bottom_right_y=b["y2"]) for b in boxes],
        groups,
        width,
        height,
    ) if boxes else []

    snapped: list[dict] = []
    unsnapped = 0
    for box, (bbox, found) in zip(boxes, refined):
        if found:
            x1, y1 = bbox.top_left_x, bbox.top_left_y
            x2, y2 = bbox.bottom_right_x, bbox.bottom_right_y
        else:
            unsnapped += 1
            if density == "conservative":
                # Conservative mode: a box with no text under it is noise.
                continue
            x1, y1, x2, y2 = box["x1"], box["y1"], box["x2"], box["y2"]
        if (x2 - x1) < MIN_BOX_WIDTH or (y2 - y1) < MIN_BOX_PX:
            continue
        snapped.append({"x": round(x1, 1), "y": round(y1, 1),
                        "w": round(x2 - x1, 1), "h": round(y2 - y1, 1)})

    # Read top-to-bottom, left-to-right so the numbering matches how a person
    # scans the sheet.
    snapped.sort(key=lambda b: (round(b["y"] / 12), b["x"]))
    snapped = _dedupe(snapped)
    snapped = snapped[:max_boxes]

    result_boxes = [
        {"id": f"box_{i:03d}", **box} for i, box in enumerate(snapped, 1)
    ]

    result = {
        "image_width": width,
        "image_height": height,
        "boxes": result_boxes,
        "channel_used": detector._active_num,
        "elapsed_ms": int((time.time() - t0) * 1000),
        "dropped_without_text": unsnapped,
    }
    _atomic_write_json(out / "locate.json", result)
    _log(f"[locate] {len(result_boxes)} boxes in {result['elapsed_ms']}ms")
    print(json.dumps(result, ensure_ascii=False))
    return 0


# --------------------------------------------------------------------------- #
# Stage 2 — read
# --------------------------------------------------------------------------- #

def _placeholder_dimension(item_id: str, box: dict, reason: str):
    dim = create_detected_dimension(
        item_id=item_id,
        raw_data={
            "raw_text": reason,
            "bbox_top_left": [box["x"], box["y"]],
            "bbox_bottom_right": [box["x"] + box["w"], box["y"] + box["h"]],
        },
    )
    dim.confidence = 0.2
    dim.needs_review = True
    # Don't dress a failed read up as a real linear dimension in mm.
    dim.nominal_value = 0.0
    dim.unit = Unit.UNKNOWN
    dim.dimension_type = DimensionType.UNKNOWN
    dim.feature_classification = FeatureClassification.UNKNOWN
    return dim


def cmd_read(args: argparse.Namespace) -> int:
    image = Path(args.image)
    out = Path(args.out)
    boxes = json.loads(Path(args.boxes_file).read_text(encoding="utf-8"))
    progress_path = out / "progress.json"

    detector = DrawingDetector(channel=args.channel)
    detector._deadline = time.monotonic() + READ_BUDGET
    t0 = time.time()

    width, height = detector._get_image_dimensions(image)
    detector._probe_channel()

    img = Image.open(image)
    if img.mode != "RGB":
        img = img.convert("RGB")

    progress: dict = {
        "stage": "reading",
        "done": 0,
        "total": len(boxes),
        "dimensions": [],
        "failed": [],
    }
    _read_progress(progress_path, progress)

    for box in boxes:
        item_id = box["id"]
        x, y, w, h = float(box["x"]), float(box["y"]), float(box["w"]), float(box["h"])
        pad_x = max(8.0, w * 0.10)
        pad_y = max(6.0, h * 0.25)
        crop_box = (
            max(0, int(x - pad_x)),
            max(0, int(y - pad_y)),
            min(width, int(x + w + pad_x)),
            min(height, int(y + h + pad_y)),
        )
        crop = img.crop(crop_box)

        try:
            text = detector._read_crop(crop)
        except Exception as exc:  # never let one box kill the whole run
            _log(f"[read] {item_id} failed: {exc}")
            text = ""

        if text:
            raw_text = normalize_raw_text(text)
            dim = create_detected_dimension(
                item_id=item_id,
                raw_data={
                    "raw_text": raw_text,
                    "bbox_top_left": [x, y],
                    "bbox_bottom_right": [x + w, y + h],
                },
            )
            # Confidence reflects what the crop actually gave us: an explicit
            # unit/symbol is strong evidence, a bare number is weaker, and a
            # crop with no digits at all (a title or note) needs a human.
            has_unit = bool(re.search(r"(mm|inch|in\b|inches|degree|deg|[°˚])", raw_text, re.I))
            if re.search(r"\d", raw_text):
                dim.confidence = 0.92 if has_unit else 0.85
                dim.needs_review = dim.dimension_type.value == "unknown"
            else:
                dim.confidence = 0.35
                dim.needs_review = True
        else:
            progress["failed"].append(item_id)
            dim = _placeholder_dimension(item_id, box, "读取失败 · 待复核")

        progress["dimensions"].append(dim.model_dump(mode="json"))
        progress["done"] += 1
        _read_progress(progress_path, progress)

    dimensions = progress["dimensions"]
    result = DetectionResult(
        image_path=str(image),
        image_width=width,
        image_height=height,
        dimensions=dimensions,
        total_detected=len(dimensions),
        needs_review_count=sum(1 for d in dimensions if d.get("needs_review")),
    )

    # Static annotated image is only produced for export / download; the live
    # UI draws its boxes in the browser.
    try:
        draw_bounding_boxes(image, result, out / "annotated.png")
    except Exception as exc:  # export is a nice-to-have, never fatal
        _log(f"[read] annotated export failed: {exc}")

    payload = {
        "image_width": width,
        "image_height": height,
        "dimensions": dimensions,
        "total_detected": result.total_detected,
        "needs_review_count": result.needs_review_count,
        "failed": progress["failed"],
        "channel_used": detector._active_num,
        "elapsed_ms": int((time.time() - t0) * 1000),
    }
    _atomic_write_json(out / "read.json", payload)
    _read_progress(progress_path, {**progress, "stage": "done"})
    _log(
        f"[read] {result.total_detected} dims "
        f"({result.needs_review_count} review) in {payload['elapsed_ms']}ms"
    )
    print(json.dumps(payload, ensure_ascii=False))
    return 0


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Two-stage drawing detection CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_locate = sub.add_parser("locate", help="find annotation boxes (no text)")
    p_locate.add_argument("--image", required=True)
    p_locate.add_argument("--out", required=True)
    p_locate.add_argument("--channel", type=int, default=2)
    p_locate.add_argument("--config", default="{}")
    p_locate.set_defaults(func=cmd_locate)

    p_read = sub.add_parser("read", help="read text inside confirmed boxes")
    p_read.add_argument("--image", required=True)
    p_read.add_argument("--out", required=True)
    p_read.add_argument("--channel", type=int, default=2)
    p_read.add_argument("--boxes-file", required=True)
    p_read.set_defaults(func=cmd_read)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except RuntimeError as exc:
        # LLM channel problems (timeout / unavailable / misconfigured) are
        # expected operational failures — report them as a clear message.
        print(f"ERROR: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:  # pragma: no cover - defensive
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
