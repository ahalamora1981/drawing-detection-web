"""Normalise the bounding boxes a vision model returns.

The locate prompt asks for two 2-number fields::

    {"bbox_top_left": [x1, y1], "bbox_bottom_right": [x2, y2]}

Models do not reliably honour that shape. Two other shapes show up in practice
on the same model, same image, same temperature::

    {"bbox_top_left": [x1, y1, x2, y2], "bbox_bottom_right": [x2, y2]}       # (B)
    {"bbox_top_left": [x1, y1, x2, y2], "bbox_bottom_right": [x1, y1, x2, y2]}  # (C)

Shape C used to be read as ``top_left[0:2]`` -> ``bottom_right[0:2]``, which
collapses the rectangle to a zero-size point sitting on its own top-left
corner. Everything downstream then treated that corner as the box centre, so
the box either snapped onto a neighbouring annotation or was dropped. Parsing
each shape explicitly, and rejecting degenerate boxes instead of keeping a
point, removes that whole failure class.

Coordinate space is decided ONCE for a whole response, not per box: the prompt
asks for 0-1000 normalised coordinates, so that is the default, and a value
above 1000 proves the model answered in pixels instead.
"""

from __future__ import annotations

from typing import Any, Iterable

NORM_SPACE = 1000.0

# A box thinner than this carries no text and is never worth keeping: it is a
# collapsed point or a stray line segment.
MIN_SIDE_PX = 2.0

# Tolerance on the "is this coordinate outside the normalised range" test.
_NORM_EPS = 1.5


def _numbers(value: Any) -> list[float] | None:
    """Coerce a JSON value into a list of floats, or None."""
    if isinstance(value, dict):
        # {"x": .., "y": .., "w": .., "h": ..} or {"x1": .., ...}
        if {"x", "y", "w", "h"} <= value.keys():
            return _numbers([value["x"], value["y"], value["w"], value["h"]])
        if {"x1", "y1", "x2", "y2"} <= value.keys():
            return _numbers([value["x1"], value["y1"], value["x2"], value["y2"]])
        return None
    if not isinstance(value, (list, tuple)):
        return None
    out: list[float] = []
    for item in value:
        try:
            out.append(float(item))
        except (TypeError, ValueError):
            return None
    return out


def item_rect(item: dict) -> tuple[float, float, float, float] | None:
    """Extract one rectangle from a model item, in the model's own space.

    Accepts, in order of preference:

    * ``bbox_top_left`` with 4 numbers -> ``[x1, y1, x2, y2]`` (shapes B and C;
      the second field is then redundant and ignored),
    * ``bbox_top_left`` + ``bbox_bottom_right`` with 2 numbers each (shape A),
    * ``bbox`` as ``[x, y, w, h]`` or ``{x, y, w, h}``.
    """
    for tl_key, br_key in (
        ("bbox_top_left", "bbox_bottom_right"),
        ("top_left", "bottom_right"),
    ):
        tl = _numbers(item.get(tl_key))
        if tl is None:
            continue
        if len(tl) >= 4:
            return tl[0], tl[1], tl[2], tl[3]
        br = _numbers(item.get(br_key))
        if len(tl) >= 2 and br is not None and len(br) >= 2:
            return tl[0], tl[1], br[0], br[1]

    bbox = _numbers(item.get("bbox"))
    if bbox is not None and len(bbox) >= 4:
        x, y, w, h = bbox[0], bbox[1], bbox[2], bbox[3]
        return x, y, x + w, y + h
    return None


def decide_space(
    rects: Iterable[tuple[float, float, float, float]]
) -> str:
    """Return ``"norm"`` (0-1000) or ``"pixel"`` for a whole response.

    The prompt asks for normalised coordinates, so that is the default. A single
    coordinate outside 0-1000 is impossible in that space and proves the model
    switched to pixels; deciding once keeps the answer consistent across items.
    """
    limit = NORM_SPACE + _NORM_EPS
    for rect in rects:
        if any(v > limit for v in rect):
            return "pixel"
    return "norm"


def to_pixels(
    rect: tuple[float, float, float, float],
    space: str,
    image_width: int,
    image_height: int,
) -> tuple[float, float, float, float]:
    """Scale one rectangle into image pixels and clamp it to the image."""
    x1, y1, x2, y2 = rect
    if space == "norm":
        x1 = x1 * image_width / NORM_SPACE
        x2 = x2 * image_width / NORM_SPACE
        y1 = y1 * image_height / NORM_SPACE
        y2 = y2 * image_height / NORM_SPACE
    # Order first, then clamp: models occasionally swap the corners.
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    return (
        max(0.0, min(float(image_width), x1)),
        max(0.0, min(float(image_height), y1)),
        max(0.0, min(float(image_width), x2)),
        max(0.0, min(float(image_height), y2)),
    )


def parse_boxes(
    items: list[dict], image_width: int, image_height: int
) -> tuple[list[dict], dict]:
    """Turn model items into pixel boxes, dropping the ones with no area.

    Returns ``(boxes, stats)`` where each box is ``{x1, y1, x2, y2}`` and stats
    carries ``space``, ``items`` and ``invalid`` counts so the caller can log
    what the model actually did instead of guessing.
    """
    rects = [r for r in (item_rect(item) for item in items) if r is not None]
    space = decide_space(rects)
    boxes: list[dict] = []
    invalid = 0
    for rect in rects:
        x1, y1, x2, y2 = to_pixels(rect, space, image_width, image_height)
        if (x2 - x1) < MIN_SIDE_PX or (y2 - y1) < MIN_SIDE_PX:
            invalid += 1
            continue
        boxes.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2})
    stats = {
        "space": space,
        "items": len(items),
        "parsed": len(rects),
        "invalid": invalid,
    }
    return boxes, stats
