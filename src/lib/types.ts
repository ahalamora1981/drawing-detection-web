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
  /** True when the crop could not be read at all. */
  read_failed?: boolean;
}

/** A box produced by the locate stage. Pixel coordinates on the original image. */
export interface RunBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * How sure the locator is that this box sits on printed text:
   * 0.9 overlapping text, 0.75 near text, 0.5 a far match, 0.35 no text found.
   */
  confidence?: number;
  /** "matched" (locked onto text), "unsure" (needs a look), "user" (drawn). */
  source?: "matched" | "unsure" | "user";
}

/** User-facing locate options. Each one actually changes the request sent to the model. */
export interface RunConfig {
  scope: "dimensions" | "all_text";
  density: "conservative" | "standard" | "aggressive";
  excludeTitleBlock: boolean;
}

export type RunStage =
  | "queued"
  | "locating"
  | "located"
  | "reading"
  | "done"
  | "error";

export type RunStep = "locate" | "read";

export interface RunQueueState {
  position: number; // 1 = next in line, 0 = running now
  step: RunStep;
}

export interface RunState {
  id: string;
  session: string;
  filename: string;
  /** Original filename for uploads (stored names carry a timestamp prefix). */
  originalName: string | null;
  displayName: string;
  source: "test" | "upload";
  imageWidth: number;
  imageHeight: number;
  config: RunConfig;
  channel: number;
  stage: RunStage;
  queue: RunQueueState | null;
  boxes: RunBox[];
  dimensions: DetectedDimension[];
  progress: { done: number; total: number };
  failed: string[];
  locateMs: number | null;
  readMs: number | null;
  channelUsed: number | null;
  error: string | null;
  /** Stable code for the last failure, so the UI can localise it. */
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Lightweight run summary shown on a gallery card. */
export interface RunSummary {
  id: string;
  stage: RunStage;
  boxCount: number;
  detectedCount: number;
  reviewCount: number;
}

export interface GalleryImage {
  filename: string;
  /** Original filename for uploads (the stored name is a timestamp). */
  originalName?: string;
  displayName: string;
  thumbnailUrl: string;
  fullUrl: string;
  source: "test" | "upload";
  run: RunSummary | null;
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
