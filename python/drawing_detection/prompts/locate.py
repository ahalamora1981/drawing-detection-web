"""Prompt for the locate stage (boxes only, no transcription)."""

LOCATE_PROMPT = """You are an expert engineering drawing reader. Locate EVERY dimension annotation printed on the drawing in this image.

A dimension annotation is a numeric value together with a unit, tolerance, or symbol that specifies a size or angle of a feature. Examples: "47 ±0.025 mm", "Φ3.5", "30°", "4X Φ10 ±0.05", "R5", "3.250 ±0.005 INCH".

This task is ONLY about LOCATION. Do NOT transcribe, translate, interpret, classify, or judge anything. Return boxes only.

Use a NORMALIZED coordinate system: the image maps to x in [0, 1000] (left to right) and y in [0, 1000] (top to bottom). Report bounding boxes in this 0-1000 space, tightly enclosing the printed annotation text.

For each annotation return one JSON object with exactly these two fields:
- "bbox_top_left": [x1, y1]
- "bbox_bottom_right": [x2, y2]

Rules:
- Scan the whole image: every corner, every edge, inside the part geometry, near arrows and leader lines, horizontal, vertical and rotated text.
- Box the annotation exactly where it is printed; a box that encloses unrelated text (titles, notes, labels) is a wrong answer.
- NEVER box titles, title blocks, part names, notes, prose, or the drawing border/frame. Text like "BASEPLATE - MM TEST" is a drawing title, not a dimension.
- Do not invent annotations that are not printed.
- Return ONLY a JSON array of objects, with no markdown, no commentary."""

LOCATE_RETRY_PROMPT = (
    "Your previous response could not be used. Locate ALL dimension annotations "
    "on the drawing and return ONLY a JSON array of objects with the fields "
    "bbox_top_left and bbox_bottom_right, using the 0-1000 normalized "
    "coordinate space. Do not transcribe any text. If there are no dimension "
    "annotations, return []."
)


# Config -> extra prompt lines. Every option here must actually change the
# request, otherwise the UI would be lying about what it does.
_SCOPE_LINES = {
    "dimensions": (
        "Scope: dimension annotations only. Ignore technical requirement notes, "
        "surface-finish symbols, weld symbols and general tolerance blocks."
    ),
    "all_text": (
        "Scope: every annotation that carries a value, including dimension "
        "annotations AND technical requirement notes that state a numeric "
        "specification. Still ignore the title block, part names and prose."
    ),
}

_GRANULARITY_LINES = {
    "annotation": (
        "Granularity: one box per printed annotation, so a value and its "
        "tolerance/unit stay in the SAME box (e.g. \"4X Φ10 ±0.05\" is one box)."
    ),
    "value": (
        "Granularity: one box per individual numeric value. Split \"4X Φ10 ±0.05\" "
        "into separate boxes for the quantity/value and for the tolerance."
    ),
}

_DENSITY_LINES = {
    "conservative": (
        "Density: be conservative. Only box annotations you are confident are "
        "real dimension annotations; when unsure, leave it out."
    ),
    "standard": (
        "Density: standard. Box every clear dimension annotation; use judgement "
        "on ambiguous marks."
    ),
    "aggressive": (
        "Density: be exhaustive. Box every candidate annotation, including "
        "faint, small, rotated or partially occluded ones."
    ),
}


def build_locate_prompt(config: dict | None) -> str:
    """Compose the locate prompt from the user's configuration."""
    cfg = config or {}
    parts = [LOCATE_PROMPT]
    for key, table in (
        ("scope", _SCOPE_LINES),
        ("granularity", _GRANULARITY_LINES),
        ("density", _DENSITY_LINES),
    ):
        line = table.get(str(cfg.get(key, "")).lower())
        if line:
            parts.append(line)
    if cfg.get("exclude_title_block"):
        parts.append(
            "Explicitly exclude the bottom-right title block area and any "
            "revision table, regardless of their content."
        )
    return "\n\n".join(parts)
