"""Parse and validate extracted dimension data."""

import re

from .models import (
    BoundingBox,
    DetectedDimension,
    DimensionType,
    FeatureClassification,
    Unit,
)
from .classifier import classify_dimension


# Regexes for common dimension formats
_QTY_RE = re.compile(r"^(\d+)\s*[Xx×]\s*")            # "4X Φ10 ±0.05" -> quantity 4
_DIAMETER_RE = re.compile(r"[ΦφØ⌀∅ø]")               # diameter symbols (incl. ∅ from OCR)
_ANGLE_RE = re.compile(r"[°˚]")                        # degree symbols
_RADIUS_RE = re.compile(r"(?<![A-Za-z])[Rr]\s*(\d+\.?\d*)")  # "R5"
_SYMMETRIC_TOL_RE = re.compile(r"[±]\s*(\d+\.?\d*)")   # "±0.025"
_ASYMMETRIC_TOL_RE = re.compile(
    r"[+]?\s*(\d+\.?\d*)\s*/\s*[-−]\s*(\d+\.?\d*)"
)  # "+0.1/-0.05"
_NUMBER_RE = re.compile(r"\d+\.?\d*")
_UNIT_RE = re.compile(r"\b(mm|inch|in|inches|degree|deg|°)\b", re.IGNORECASE)
# Stacked tolerances printed without a slash: "+0.02-0.01"
_STACKED_TOL_RE = re.compile(r"[+]\s*(\d+\.?\d*)\s*[-−]\s*(\d+\.?\d*)")

# Vision models often transcribe stacked tolerances as Unicode super/subscripts
# ("Φ40⁺⁰·⁰²₋₀.₀₁"). Fold them back to plain characters before parsing.
_SUPERSCRIPT_MAP = str.maketrans({
    "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
    "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
    "⁺": "+", "⁻": "-", "·": ".", "⋅": ".", "﹣": "-", "－": "-",
})
_SUBSCRIPT_MAP = str.maketrans({
    "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
    "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
    "₊": "+", "₋": "-", "․": ".", "₋": "-",
})


def normalize_raw_text(raw_text: str) -> str:
    """Normalize spacing/formatting of raw dimension text from an LLM.

    Turns e.g. "47 ± 0.025 mm" into "47 ±0.025 mm" so that equivalent texts
    can be compared and de-duplicated.
    """
    text = raw_text.strip()
    text = text.translate(_SUPERSCRIPT_MAP).translate(_SUBSCRIPT_MAP)
    # Some vision models answer in LaTeX/markdown math ("2X $\\phi$12").
    # Fold those back to the plain symbols a drawing actually prints.
    text = re.sub(r"\$?\\[Pp]hi\$?", "Φ", text)
    text = re.sub(r"\$?\\[Dd]iameter\$?", "Φ", text)
    text = text.replace("$", "")
    text = _DIAMETER_RE.sub(lambda m: m.group(0), text)  # keep symbol as-is
    text = re.sub(r"\s*±\s*", " ±", text)              # "± 0.025" -> "±0.025"
    text = re.sub(r"\s*([ΦφØ⌀∅ø°˚])\s*", r"\1", text)  # "Φ 3.5" -> "Φ3.5"
    text = re.sub(r"\s*[Xx×]\s*", "X", text)             # "4 X 10" -> "4X10"
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_raw_text(raw_text: str) -> dict:
    """
    Parse a raw dimension text string into components.

    Args:
        raw_text: Raw text like "47 ±0.025 mm" or "Φ3.5"

    Returns:
        Dictionary with parsed components
    """
    result = {
        "nominal_value": 0.0,
        "tolerance": None,
        "tolerance_plus": None,
        "tolerance_minus": None,
        "unit": Unit.UNKNOWN,
        "dimension_type": DimensionType.UNKNOWN,
        "quantity": 1,
    }

    text = raw_text.strip()

    # Check for quantity multiplier (e.g., "4X")
    qty_match = _QTY_RE.match(text)
    if qty_match:
        result["quantity"] = int(qty_match.group(1))
        text = text[qty_match.end():]

    # Detect radius before diameter text removal
    radius_match = _RADIUS_RE.search(text)
    if radius_match and not _DIAMETER_RE.search(text):
        result["dimension_type"] = DimensionType.RADIUS

    # Detect diameter symbol
    if _DIAMETER_RE.search(text):
        result["dimension_type"] = DimensionType.DIAMETER
        text = _DIAMETER_RE.sub("", text)

    # Detect angle symbol (unit is implicit for angles)
    if _ANGLE_RE.search(text):
        result["dimension_type"] = DimensionType.ANGLE
        result["unit"] = Unit.DEGREE
        text = _ANGLE_RE.sub("", text)

    # Extract tolerance: asymmetric first ("+0.1/-0.05"), then symmetric ("±0.025")
    asym = _ASYMMETRIC_TOL_RE.search(text)
    if asym:
        plus = float(asym.group(1))
        minus = -float(asym.group(2))
        result["tolerance_plus"] = plus
        result["tolerance_minus"] = minus
        result["tolerance"] = plus if abs(plus) >= abs(minus) else abs(minus)
        text = text[: asym.start()] + " " + text[asym.end():]
    else:
        stacked = _STACKED_TOL_RE.search(text)
        if stacked:
            plus = float(stacked.group(1))
            minus = -float(stacked.group(2))
            result["tolerance_plus"] = plus
            result["tolerance_minus"] = minus
            result["tolerance"] = plus
            text = text[: stacked.start()] + " " + text[stacked.end():]
        tol = None if stacked else _SYMMETRIC_TOL_RE.search(text)
        if tol:
            value = float(tol.group(1))
            result["tolerance"] = value
            result["tolerance_plus"] = value
            result["tolerance_minus"] = -value
            # Remove only the tolerance span, keep the rest (may contain unit)
            text = text[: tol.start()] + " " + text[tol.end():]

    # Detect unit BEFORE stripping numbers (unit may follow the tolerance)
    unit_match = _UNIT_RE.search(text)
    if unit_match:
        unit_word = unit_match.group(1).lower()
        if unit_word in ("mm",):
            result["unit"] = Unit.MM
        elif unit_word in ("inch", "in", "inches"):
            result["unit"] = Unit.INCH
        elif unit_word in ("degree", "deg", "°"):
            result["unit"] = Unit.DEGREE

    # Extract numeric value
    num_match = _NUMBER_RE.search(text)
    if num_match:
        result["nominal_value"] = float(num_match.group(0))

    # Fallback unit: angles already set; otherwise assume mm (engineering default)
    if result["unit"] == Unit.UNKNOWN and result["dimension_type"] != DimensionType.ANGLE:
        result["unit"] = Unit.MM

    # Default dimension type if not set
    if result["dimension_type"] == DimensionType.UNKNOWN:
        result["dimension_type"] = DimensionType.LINEAR

    return result


def parse_bbox(raw_bbox: list | tuple) -> BoundingBox:
    """
    Parse bounding box coordinates.

    Args:
        raw_bbox: List/tuple with [x1, y1, x2, y2] or {"top_left": [x1,y1], "bottom_right": [x2,y2]}

    Returns:
        BoundingBox object
    """
    if isinstance(raw_bbox, dict):
        # Handle dict format from LLM
        tl = raw_bbox.get("top_left", raw_bbox.get("bbox_top_left", [0, 0]))
        br = raw_bbox.get("bottom_right", raw_bbox.get("bbox_bottom_right", [0, 0]))
        return BoundingBox(
            top_left_x=float(tl[0]),
            top_left_y=float(tl[1]),
            bottom_right_x=float(br[0]),
            bottom_right_y=float(br[1]),
        )
    elif isinstance(raw_bbox, (list, tuple)) and len(raw_bbox) == 2:
        # Handle [top_left, bottom_right] format
        tl, br = raw_bbox
        return BoundingBox(
            top_left_x=float(tl[0]),
            top_left_y=float(tl[1]),
            bottom_right_x=float(br[0]),
            bottom_right_y=float(br[1]),
        )
    else:
        # Fallback
        return BoundingBox(top_left_x=0, top_left_y=0, bottom_right_x=0, bottom_right_y=0)


def _coerce_number(value, default):
    """Best-effort numeric coercion for LLM-provided fields.

    The LLM occasionally returns numbers as strings, e.g. tolerance
    "+/-0.03" or "±0.03". Coerce to float; fall back to `default` when
    the value is None or unparseable.
    """
    if value is None or isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip().replace("−", "-").replace("±", "")
        try:
            return float(s)
        except ValueError:
            # Symmetric-tolerance strings like "+/-0.03" or "+-0.03"
            match = re.search(r"\d+\.?\d*", s)
            if match:
                return float(match.group(0))
    return default


def create_detected_dimension(
    item_id: str,
    raw_data: dict,
) -> DetectedDimension:
    """
    Create a DetectedDimension from raw LLM output.

    Args:
        item_id: Unique identifier for this dimension
        raw_data: Raw dictionary from LLM extraction

    Returns:
        Validated DetectedDimension object
    """
    raw_text = raw_data.get("raw_text", "")

    # Parse the raw text to get structured data
    parsed = parse_raw_text(raw_text)

    # Use LLM-provided values where available, fallback to parsed values.
    # Coerce defensively: the LLM may return strings ("+/-0.03") or null.
    nominal_value = _coerce_number(
        raw_data.get("nominal_value"), parsed["nominal_value"]
    )
    tolerance = _coerce_number(raw_data.get("tolerance"), parsed["tolerance"])
    tolerance_plus = _coerce_number(
        raw_data.get("tolerance_plus"), parsed["tolerance_plus"]
    )
    tolerance_minus = _coerce_number(
        raw_data.get("tolerance_minus"), parsed["tolerance_minus"]
    )
    quantity = raw_data.get("quantity", parsed["quantity"])
    try:
        quantity = int(float(quantity))
    except (TypeError, ValueError):
        quantity = parsed["quantity"]

    # Parse unit
    unit_str = raw_data.get("unit", parsed["unit"].value)
    try:
        unit = Unit(unit_str)
    except ValueError:
        unit = parsed["unit"]

    # Parse dimension type
    dtype_str = raw_data.get("dimension_type", parsed["dimension_type"].value)
    try:
        dimension_type = DimensionType(dtype_str)
    except ValueError:
        dimension_type = parsed["dimension_type"]

    # Parse bounding box
    bbox_top_left = raw_data.get("bbox_top_left", [0, 0])
    bbox_bottom_right = raw_data.get("bbox_bottom_right", [0, 0])
    bbox = BoundingBox(
        top_left_x=float(bbox_top_left[0]),
        top_left_y=float(bbox_top_left[1]),
        bottom_right_x=float(bbox_bottom_right[0]),
        bottom_right_y=float(bbox_bottom_right[1]),
    )

    # Classify feature
    feature_classification = classify_dimension(
        dimension_type, raw_text, nominal_value, unit
    )

    # Determine confidence and review flag
    confidence = 0.8  # Default confidence
    needs_review = False

    # Low confidence if we couldn't parse properly
    if nominal_value == 0.0:
        confidence = 0.3
        needs_review = True
    if unit == Unit.UNKNOWN:
        confidence = min(confidence, 0.5)
        needs_review = True
    if dimension_type == DimensionType.UNKNOWN:
        confidence = min(confidence, 0.5)
        needs_review = True

    return DetectedDimension(
        item_id=item_id,
        raw_text=raw_text,
        nominal_value=nominal_value,
        tolerance=tolerance,
        tolerance_plus=tolerance_plus,
        tolerance_minus=tolerance_minus,
        quantity=quantity,
        unit=unit,
        dimension_type=dimension_type,
        feature_classification=feature_classification,
        confidence=confidence,
        bbox=bbox,
        needs_review=needs_review,
    )
