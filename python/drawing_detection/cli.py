"""CLI entry point for drawing detection."""

import argparse
import csv
import json
import sys
from datetime import datetime
from pathlib import Path

from .detector import SUPPORTED_EXTENSIONS, DrawingDetector
from .models import DetectionResult
from .visualizer import draw_bounding_boxes


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Extract dimensions from engineering drawings using Vision LLM"
    )
    parser.add_argument(
        "image",
        type=str,
        help="Path to the engineering drawing image, or a directory to process all images",
    )
    parser.add_argument(
        "-o", "--output",
        type=str,
        default=None,
        help="Output JSON file path, or output directory in batch mode "
             "(default: output/ in the current directory)",
    )
    parser.add_argument(
        "--csv",
        type=str,
        default=None,
        help="Also write a CSV summary to this path",
    )
    parser.add_argument(
        "--api-key",
        type=str,
        default=None,
        help="API key (default: LLM_API_KEY env var or .env file)",
    )
    parser.add_argument(
        "--base-url",
        type=str,
        default=None,
        help="LLM API base URL (default: LLM_BASE_URL env var or STG AI server)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Model ID (default: LLM_MODEL env var)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty print JSON output",
    )
    parser.add_argument(
        "--no-annotate",
        action="store_true",
        help="Skip saving the annotated image",
    )
    parser.add_argument(
        "--no-verify",
        action="store_true",
        help="Skip LLM crop-verification of questionable dimension locations "
             "(faster, but displaced boxes may go uncaught)",
    )
    return parser


def _load_env() -> None:
    """Load .env from the project root if present."""
    env_file = Path(__file__).resolve().parent.parent.parent / ".env"
    if env_file.exists():
        from dotenv import load_dotenv
        load_dotenv(env_file)


def _output_dir() -> Path:
    out = Path("output")
    out.mkdir(exist_ok=True)
    return out


def _save_json(result: DetectionResult, output_path: Path, pretty: bool) -> None:
    result_dict = result.to_dict()
    with open(output_path, "w", encoding="utf-8") as f:
        if pretty:
            json.dump(result_dict, f, indent=2, ensure_ascii=False)
        else:
            json.dump(result_dict, f, ensure_ascii=False)


def _save_csv(results: list[tuple[Path, DetectionResult]], csv_path: Path) -> None:
    """Write a combined CSV summary of one or more detection results."""
    fieldnames = [
        "image", "item_id", "raw_text", "nominal_value", "tolerance",
        "tolerance_plus", "tolerance_minus", "quantity", "unit",
        "dimension_type", "feature_classification", "confidence",
        "needs_review", "bbox_center_x", "bbox_center_y",
        "bbox_top_left_x", "bbox_top_left_y",
        "bbox_bottom_right_x", "bbox_bottom_right_y",
    ]
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for image_path, result in results:
            for dim in result.dimensions:
                cxs, cys = dim.bbox.center
                writer.writerow({
                    "image": str(image_path),
                    "item_id": dim.item_id,
                    "raw_text": dim.raw_text,
                    "nominal_value": dim.nominal_value,
                    "tolerance": dim.tolerance,
                    "tolerance_plus": dim.tolerance_plus,
                    "tolerance_minus": dim.tolerance_minus,
                    "quantity": dim.quantity,
                    "unit": dim.unit.value,
                    "dimension_type": dim.dimension_type.value,
                    "feature_classification": dim.feature_classification.value,
                    "confidence": dim.confidence,
                    "needs_review": dim.needs_review,
                    "bbox_center_x": round(cxs, 1),
                    "bbox_center_y": round(cys, 1),
                    "bbox_top_left_x": dim.bbox.top_left_x,
                    "bbox_top_left_y": dim.bbox.top_left_y,
                    "bbox_bottom_right_x": dim.bbox.bottom_right_x,
                    "bbox_bottom_right_y": dim.bbox.bottom_right_y,
                })


def process_image(detector: DrawingDetector, image_path: Path, args) -> DetectionResult:
    """Detect dimensions in one image and save outputs; returns the result."""
    result = detector.detect(image_path)

    if args.output:
        output_path = Path(args.output)
        if output_path.suffix.lower() == ".json":
            json_path = output_path
        else:
            json_path = output_path / f"{image_path.stem}_result.json"
            json_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        json_path = _output_dir() / f"{image_path.stem}_result.json"

    _save_json(result, json_path, args.pretty)

    annotated_path = None
    if not args.no_annotate:
        annotated_path = json_path.with_name(json_path.stem + "_annotated" + image_path.suffix)
        draw_bounding_boxes(image_path, result, annotated_path)

    print(
        f"  {image_path.name}: {result.total_detected} dimension(s), "
        f"{result.needs_review_count} need review -> {json_path}",
        file=sys.stderr,
    )
    return result


def main() -> None:
    """Main CLI entry point."""
    args = build_parser().parse_args()
    _load_env()

    image_arg = Path(args.image)
    if not image_arg.exists():
        print(f"Error: Image file not found: {image_arg}", file=sys.stderr)
        sys.exit(1)

    if image_arg.is_dir():
        images = sorted(
            p for p in image_arg.iterdir() if p.suffix.lower() in SUPPORTED_EXTENSIONS
        )
        if not images:
            print(f"Error: No supported images found in {image_arg}", file=sys.stderr)
            sys.exit(1)
    else:
        images = [image_arg]

    try:
        detector = DrawingDetector(
            api_key=args.api_key,
            base_url=args.base_url,
            model=args.model,
            verify=not args.no_verify,
        )
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    results: list[tuple[Path, DetectionResult]] = []
    total = review = 0
    try:
        for image_path in images:
            print(f"Analyzing image: {image_path}", file=sys.stderr)
            result = process_image(detector, image_path, args)
            results.append((image_path, result))
            total += result.total_detected
            review += result.needs_review_count
    except Exception as e:
        print(f"Error processing {image_path}: {e}", file=sys.stderr)
        sys.exit(1)

    if args.csv:
        csv_path = Path(args.csv)
        _save_csv(results, csv_path)
        print(f"  CSV saved to: {csv_path}", file=sys.stderr)

    # Summary
    print(
        f"\nDone! {len(images)} image(s), {total} dimension(s) total, "
        f"{review} need review.",
        file=sys.stderr,
    )

    if len(images) == 1:
        # Print the single-image JSON to stdout (machine-readable)
        result = results[0][1]
        if args.pretty:
            print(json.dumps(result.to_dict(), indent=2, ensure_ascii=False))
        else:
            print(json.dumps(result.to_dict(), ensure_ascii=False))


if __name__ == "__main__":
    main()
