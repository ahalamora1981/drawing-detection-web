export interface BoundingBox {
  top_left_x: number;
  top_left_y: number;
  bottom_right_x: number;
  bottom_right_y: number;
}

export interface DetectedDimension {
  item_id: string;
  raw_text: string;
  nominal_value: number;
  tolerance: number | null;
  tolerance_plus: number | null;
  tolerance_minus: number | null;
  quantity: number;
  unit: string;
  dimension_type: string;
  feature_classification: string;
  confidence: number;
  bbox: BoundingBox;
  needs_review: boolean;
}

export interface DetectionResult {
  image_path: string;
  image_width: number;
  image_height: number;
  dimensions: DetectedDimension[];
  total_detected: number;
  needs_review_count: number;
}

export interface TestImage {
  filename: string;
  displayName: string;
  thumbnailUrl: string;
  fullUrl: string;
  result?: DetectionResult | null;
  annotatedUrl?: string | null;
  source?: "test" | "upload";
}

export interface ComparisonResult {
  image: string;
  match: boolean;
  differences: string[];
  detected_count: number;
  expected_count: number;
  detected_review_count: number;
  expected_review_count: number;
}
