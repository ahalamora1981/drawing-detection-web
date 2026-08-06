"""Visualize detection results by drawing bounding boxes on images."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .models import DetectionResult

# Colors for different dimension types
COLORS = {
    "linear": (0, 160, 0),       # Green
    "diameter": (200, 0, 0),     # Red
    "angle": (0, 0, 200),        # Blue
    "radius": (230, 120, 0),     # Orange
    "unknown": (128, 128, 128),  # Gray
}

REVIEW_COLOR = (255, 165, 0)  # orange outline for items needing review

# Common font paths across platforms (Windows / macOS / Linux)
_FONT_CANDIDATES = [
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/consola.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNS.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
]


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except (IOError, OSError):
            continue
    return ImageFont.load_default()


def _label_rects(
    dims, img_width: int, img_height: int, padding: int
) -> list[tuple[int, int, int, int, tuple, str]]:
    """Pick a collision-free label position for every dimension.

    Returns (label_x, label_y, label_w, label_h, color, text) per dimension.
    Labels are placed above the box when possible, then below, then to the
    right, then to the left; always avoiding every dimension box (incl. own).
    """
    boxes = []
    for dim in dims:
        b = dim.bbox
        x1 = max(0, int(b.top_left_x) - padding)
        y1 = max(0, int(b.top_left_y) - padding)
        x2 = min(img_width - 1, int(b.bottom_right_x) + padding)
        y2 = min(img_height - 1, int(b.bottom_right_y) + padding)
        boxes.append((x1, y1, x2, y2))

    font_size = max(11, min(22, img_width // 55))
    font = _load_font(font_size)
    draw = ImageDraw.Draw(Image.new("RGB", (1, 1)))

    labels = []
    for i, (dim, (x1, y1, x2, y2)) in enumerate(zip(dims, boxes)):
        color = COLORS.get(dim.dimension_type.value, COLORS["unknown"])
        if dim.needs_review:
            color = REVIEW_COLOR
        text = f"{dim.item_id}: {dim.raw_text}"
        if dim.needs_review:
            text += " [?]"
        tb = draw.textbbox((0, 0), text, font=font)
        label_w = tb[2] - tb[0]
        label_h = tb[3] - tb[1]

        other_boxes = boxes  # label must not cover ANY box, including its own
        candidates = [
            (x1, y1 - label_h - 6),      # above
            (x1, y2 + 6),                # below
            (x2 + 6, y1),                # right
            (x1 - label_w - 6, y1),      # left
            (x1, y1),                    # inside (last resort)
        ]
        placed = None
        for lx, ly in candidates:
            # candidate must fit inside the image
            if lx < 0 or ly < 0:
                continue
            if lx + label_w + 6 > img_width or ly + label_h + 6 > img_height:
                continue
            lrect = (lx, ly, lx + label_w + 6, ly + label_h + 6)
            if any(
                lrect[0] < bx2 and lrect[2] > bx1 and lrect[1] < by2 and lrect[3] > by1
                for (bx1, by1, bx2, by2) in other_boxes
            ):
                continue
            placed = (lx, ly)
            break
        if placed is None:
            placed = (
                max(0, min(x1, img_width - label_w - 6)),
                max(0, y1 - label_h - 6),
            )
        labels.append((placed[0], placed[1], label_w, label_h, color, text))
    return labels


def draw_bounding_boxes(
    image_path: str | Path,
    result: DetectionResult,
    output_path: str | Path,
    padding: int = 5,
) -> Path:
    """
    Draw bounding boxes on the image and save to output path.

    Args:
        image_path: Path to the original image.
        result: DetectionResult containing detected dimensions.
        output_path: Path to save the annotated image.
        padding: Padding around bounding boxes in pixels.

    Returns:
        Path to the saved annotated image.
    """
    image_path = Path(image_path)
    output_path = Path(output_path)

    # Open the image (composite transparency onto white)
    img = Image.open(image_path)
    if img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info:
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        bg.alpha_composite(rgba)
        img = bg
    img = img.convert("RGB")
    draw = ImageDraw.Draw(img)

    font_size = max(11, min(22, img.width // 55))
    font = _load_font(font_size)
    labels = _label_rects(result.dimensions, img.width, img.height, padding)

    # Boxes first, then labels on top
    for dim in result.dimensions:
        bbox = dim.bbox
        color = COLORS.get(dim.dimension_type.value, COLORS["unknown"])
        if dim.needs_review:
            color = REVIEW_COLOR

        x1 = max(0, int(bbox.top_left_x) - padding)
        y1 = max(0, int(bbox.top_left_y) - padding)
        x2 = min(img.width - 1, int(bbox.bottom_right_x) + padding)
        y2 = min(img.height - 1, int(bbox.bottom_right_y) + padding)

        draw.rectangle([x1, y1, x2, y2], outline=color, width=max(1, img.width // 400))

    for (lx, ly, label_w, label_h, color, text) in labels:
        draw.rectangle(
            [lx, ly, min(img.width, lx + label_w + 6), ly + label_h + 6],
            fill=color,
        )
        draw.text((lx + 3, ly + 3), text, fill=(255, 255, 255), font=font)

    # Save the annotated image
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(output_path)

    return output_path
