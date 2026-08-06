"""Feature classification for detected dimensions."""

from .models import DimensionType, FeatureClassification

# Threshold below which a linear dimension is likely a sheet thickness
# (typical sheet-metal gauges are a few mm; structural sizes are larger).
THICKNESS_MAX_MM = 5.0


def classify_dimension(
    dimension_type: DimensionType,
    raw_text: str,
    nominal_value: float,
    unit: object | None = None,
) -> FeatureClassification:
    """
    Classify a dimension based on its type and characteristics.

    Args:
        dimension_type: The type of dimension detected
        raw_text: The raw text from the drawing
        nominal_value: The nominal numeric value
        unit: Optional Unit enum value (used to scale value heuristics)

    Returns:
        Feature classification
    """
    # Diameter and radius are always hole/punch features
    if dimension_type in (DimensionType.DIAMETER, DimensionType.RADIUS):
        return FeatureClassification.HOLE_DIAMETER

    # Angle dimensions are always angle/bend features
    if dimension_type == DimensionType.ANGLE:
        return FeatureClassification.ANGLE_BEND

    # For linear dimensions, use heuristics based on value and unit
    if dimension_type == DimensionType.LINEAR:
        text_lower = raw_text.lower()
        # Explicit hints in the text
        if any(k in text_lower for k in ("thk", "thickness", "thick", "t=", "gauge")):
            return FeatureClassification.THICKNESS
        if any(k in text_lower for k in ("depth", "deep", "h=", "height")):
            return FeatureClassification.HEIGHT_DEPTH

        # Small values are likely sheet thickness (value heuristics in mm)
        value = nominal_value
        if value is None:
            # No numeric value to base the heuristic on; default classification
            return FeatureClassification.EDGE_TO_EDGE
        if unit is not None and getattr(unit, "value", None) == "inch":
            value = nominal_value * 25.4  # convert to mm for the heuristic
        if 0 < value < THICKNESS_MAX_MM:
            return FeatureClassification.THICKNESS

        # Without more context, default to edge-to-edge
        return FeatureClassification.EDGE_TO_EDGE

    return FeatureClassification.UNKNOWN
