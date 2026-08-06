"""Extraction prompt for vision LLM."""

EXTRACTION_PROMPT = """You are an expert engineering drawing reader. Analyze the drawing in this image and extract EVERY dimension annotation printed on it.

Use a NORMALIZED coordinate system: the image maps to x in [0, 1000] (left to right) and y in [0, 1000] (top to bottom). Report bounding boxes in this 0-1000 space, tightly enclosing each annotation's text.

For each dimension, return one JSON object with exactly these fields:
- "raw_text": the exact text as printed, including unit, e.g. "47 ±0.025 mm", "Φ3.5", "30°", "4X Φ10 ±0.05", "R5"
- "nominal_value": the main numeric value (number)
- "tolerance": the number after ±, or null if none
- "unit": "mm" | "inch" | "degree"
- "dimension_type": "linear" | "diameter" | "angle" | "radius"
- "bbox_top_left": [x1, y1]
- "bbox_bottom_right": [x2, y2]

Rules:
- Scan the whole image: every corner, every edge, inside the part geometry, near arrows and leader lines, horizontal and vertical text, rotated text.
- Do NOT skip dimensions without tolerances (e.g. "Φ3.5", "30°").
- Include the quantity prefix for repeated features (e.g. "4X Φ10 ±0.05").
- Never invent dimensions that are not printed.
- Return ONLY a JSON array of objects, with no markdown, no commentary."""

# Follow-up used when the first attempt returns nothing parseable or the
# model omitted bounding boxes.
RETRY_PROMPT = (
    "Your previous response could not be used because it was missing data. "
    "Extract ALL dimension annotations from the drawing and return ONLY a "
    "valid JSON array with the fields: raw_text, nominal_value, tolerance, "
    "unit, dimension_type, bbox_top_left, bbox_bottom_right (coordinates in "
    "the 0-1000 space). You MUST include bbox_top_left and "
    "bbox_bottom_right for EVERY dimension - do not omit them. "
    "If the drawing has no dimensions, return []."
)

# Used to read a single cropped text region during location verification.
VERIFY_CROP_PROMPT = (
    "Read the text printed in this image. It is a crop of an engineering "
    "drawing showing a dimension annotation. Reply with ONLY the exact text "
    "as printed, including numbers, tolerance symbols (\u00b1), units "
    "(mm/inch), and diameter (\u03a6) or angle (\u00b0) symbols. "
    "If there is no readable text, reply with exactly EMPTY."
)
