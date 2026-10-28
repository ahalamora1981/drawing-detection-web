"""Data models for drawing detection results."""

from enum import Enum
from pydantic import BaseModel, Field


class Unit(str, Enum):
    """Dimension units."""
    MM = "mm"
    INCH = "inch"
    DEGREE = "degree"
    UNKNOWN = "unknown"


class DimensionType(str, Enum):
    """Types of dimensions found in drawings."""
    LINEAR = "linear"
    DIAMETER = "diameter"
    ANGLE = "angle"
    RADIUS = "radius"
    UNKNOWN = "unknown"


class FeatureClassification(str, Enum):
    """Engineering feature classifications."""
    EDGE_TO_EDGE = "Edge-to-Edge"
    HOLE_DIAMETER = "Hole/Punch Diameter"
    ANGLE_BEND = "Angle/Bend"
    HEIGHT_DEPTH = "Height/Depth"
    LOCATION = "Location"
    THICKNESS = "Thickness"
    UNKNOWN = "Unknown"


class BoundingBox(BaseModel):
    """Bounding box with top-left and bottom-right coordinates."""
    top_left_x: float = Field(description="X coordinate of top-left corner")
    top_left_y: float = Field(description="Y coordinate of top-left corner")
    bottom_right_x: float = Field(description="X coordinate of bottom-right corner")
    bottom_right_y: float = Field(description="Y coordinate of bottom-right corner")

    @property
    def width(self) -> float:
        return self.bottom_right_x - self.top_left_x

    @property
    def height(self) -> float:
        return self.bottom_right_y - self.top_left_y

    @property
    def center(self) -> tuple[float, float]:
        return (
            (self.top_left_x + self.bottom_right_x) / 2,
            (self.top_left_y + self.bottom_right_y) / 2,
        )


class DetectedDimension(BaseModel):
    """A single dimension detected in an engineering drawing."""
    item_id: str = Field(description="Unique identifier for this dimension")
    raw_text: str = Field(description="Exact text as shown in drawing, e.g., '47 ±0.025 mm'")
    nominal_value: float = Field(description="Nominal numeric value")
    tolerance: float | None = Field(default=None, description="Tolerance value (±)")
    tolerance_plus: float | None = Field(
        default=None, description="Upper tolerance (positive), if asymmetric"
    )
    tolerance_minus: float | None = Field(
        default=None, description="Lower tolerance (negative), if asymmetric"
    )
    quantity: int = Field(default=1, description="Multiplier for repeated features (e.g. 4X)")
    unit: Unit = Field(description="Unit of measurement")
    dimension_type: DimensionType = Field(description="Type of dimension")
    feature_classification: FeatureClassification = Field(
        description="Engineering feature classification"
    )
    confidence: float = Field(ge=0.0, le=1.0, description="Detection confidence score")
    bbox: BoundingBox = Field(description="Bounding box around the dimension text")
    needs_review: bool = Field(
        default=False, description="Flag for human review if low confidence"
    )
    read_failed: bool = Field(
        default=False,
        description="True when the crop could not be read at all (no text found)",
    )


class DetectionResult(BaseModel):
    """Complete result of drawing detection."""
    image_path: str = Field(description="Path to the input image")
    image_width: int = Field(description="Width of the image in pixels")
    image_height: int = Field(description="Height of the image in pixels")
    dimensions: list[DetectedDimension] = Field(description="List of detected dimensions")
    total_detected: int = Field(description="Total number of dimensions detected")
    needs_review_count: int = Field(description="Number of dimensions needing review")

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return self.model_dump()
