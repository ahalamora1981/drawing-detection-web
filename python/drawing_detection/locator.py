"""CV-assisted text localization for refining LLM bounding boxes.

Vision LLMs are notoriously imprecise at pixel-level localization. This module
uses a cheap, deterministic connected-component analysis on the (mostly
dark-on-white) drawing image to find the *actual* text regions, then snaps each
LLM-provided bounding box to the nearest real text cluster.

This also serves as a sanity check: if no text-like pixels exist near an
LLM-detected location, the detection is flagged for human review instead of
being silently accepted.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from .models import BoundingBox

# Component analysis runs on a 2x upscaled copy so that thin strokes and small
# glyphs form solid connected components; all reported coords are in original
# image space.
ANALYSIS_SCALE = 2


@dataclass
class Component:
    """A connected component of dark pixels (analysis space)."""
    count: int
    min_x: int
    min_y: int
    max_x: int
    max_y: int

    @property
    def width(self) -> int:
        return self.max_x - self.min_x + 1

    @property
    def height(self) -> int:
        return self.max_y - self.min_y + 1

    @property
    def center(self) -> tuple[float, float]:
        return ((self.min_x + self.max_x) / 2, (self.min_y + self.max_y) / 2)


@dataclass
class TextGroup:
    """A cluster of text-like components forming one dimension annotation."""
    min_x: int
    min_y: int
    max_x: int
    max_y: int
    members: list[Component]

    @property
    def width(self) -> int:
        return self.max_x - self.min_x + 1

    @property
    def height(self) -> int:
        return self.max_y - self.min_y + 1

    @property
    def center(self) -> tuple[float, float]:
        return ((self.min_x + self.max_x) / 2, (self.min_y + self.max_y) / 2)


# --- tunables (in ORIGINAL image pixels; scaled internally) ---------------
# Component size limits for "text-like" dark regions
MIN_COMPONENT_PIXELS = 12        # ignore speckle noise
MAX_COMPONENT_PIXELS = 1500      # dense blobs are drawing geometry, not text
MIN_TEXT_HEIGHT = 7              # px; smaller than this is noise
MAX_TEXT_HEIGHT = 48             # px; larger is a line/geometry
MAX_TEXT_WIDTH = 240             # px; longer is a dimension/geometry line
MAX_COMPONENT_DENSITY = 0.80     # near-solid rectangles are geometry
MAX_ASPECT_RATIO = 4.0           # wider => horizontal line, not text

# Grouping thresholds (px, original space)
MAX_GROUP_GAP = 9                # side/side or stack gap to chain components
# Max horizontal gap INSIDE one annotation. Kept moderate: the real fix
# for two separate annotations that land on one baseline is _split_wide_group
# (below), not a tiny gap limit (which could fragment a legitimately wide
# annotation). The effective per-pair limit is further capped by
# SPLIT_GAP_HEIGHTS * glyph-height in _group_components, so a 44px
# inter-annotation gap no longer chains while sub-glyph word gaps still do.
MAX_WORD_GAP = 40                # max horizontal gap inside one annotation
# Max number of glyph-heights between the two halves of a horizontally
# merged group before we split it back into two annotations.
SPLIT_GAP_HEIGHTS = 2.4          # >=~2.4 glyph-heights => two annotations
MAX_VERTICAL_TEXT_GAP = 14       # max vertical gap for stacked (rotated) text
MIN_OVERLAP_FRACTION = 0.25      # required y/x overlap when chaining

# Title-block / prose suppression: a group of many small glyphs on one
# baseline spanning a very wide x-range is a title block, note, or caption
# (e.g. "SUPPORT BRACKET - INCH TEST") - NOT a dimension. Such groups must
# not become snap targets, or a nearby dimension box gets dragged onto them.
TITLE_MIN_MEMBERS = 8            # enough glyphs to be prose
TITLE_MIN_WIDTH = 190            # px; dimension text is usually < 160px wide
TITLE_MAX_HEIGHT = 40            # px; title block sits on one baseline
TITLE_MIN_ASPECT = 8.0           # width/height must be very wide
# A borderline group (wide but a little taller than prose) may still be a
# wide dimension; only drop it if it sits near the drawing border (bottom-)
# where title blocks live.
TITLE_BORDER_FRACTION = 0.78     # allowed only below this fraction of height

# Refinement search window. A fixed pixel radius cannot work for both a 600px
# sketch and a 6000px sheet, so the radius scales with the size of the box the
# model returned (which is roughly the text height). The old flat 160px was
# wide enough for a box to jump onto the annotation next door.
MATCH_RADIUS_FACTOR = 8.0        # x box height
MATCH_RADIUS_MIN = 60.0          # px, keeps small boxes workable
MATCH_RADIUS_MAX = 220.0         # px, hard ceiling
# Two candidate texts this close in cost means we cannot tell which one the
# model meant: the box is snapped to the better one and flagged for review.
AMBIGUOUS_RATIO = 1.6
# How much an overlapping box beats a merely close one.
OVERLAP_BONUS = 0.65
MAX_MATCH_DISTANCE = 160         # legacy helper (candidate_groups) only
BBOX_PADDING = 3                 # px added around the found text

# Snap targets must look like dimension text. Dashes, arrowheads, centreline
# crossings and section letters all survive the component filter above (they
# are small dark blobs too) and used to sit inside the old 160px window, so a
# sloppy box could snap onto the dashed bolt circle instead of the number.
MIN_GROUP_GLYPHS = 2             # a dimension is never one blob
GLYPH_MIN_HEIGHT_PX = 8          # px (original space)
GLYPH_ASPECT_MIN = 0.45          # w/h; dashes are far wider (or narrower) than a glyph
GLYPH_ASPECT_MAX = 1.8

# Bands of dims closer than this vertically are matched jointly so that
# adjacent parallel dimensions (e.g. stacked "47" / "32" texts) cannot
# both grab the same text group.
BAND_MERGE_GAP = 40


def _load_grayscale(image_path: str | Path) -> Image.Image:
    """Load image as grayscale, compositing transparency onto white."""
    img = Image.open(image_path)
    if img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info:
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        bg.alpha_composite(rgba)
        img = bg
    return img.convert("L")


def _adaptive_threshold(img: Image.Image) -> int:
    """Pick a dark threshold from the image histogram.

    Drawings are dark-on-white. We estimate the background as the most common
    gray level and place the threshold below it; clamped to a sane range.
    """
    hist = img.histogram()
    if sum(hist) == 0:
        return 200
    background = max(range(256), key=lambda i: hist[i])  # usually 255
    return max(140, min(200, background - 55))


def _find_components(img: Image.Image, threshold: int) -> list[Component]:
    """Label connected dark pixels (8-connectivity) and return components."""
    w, h = img.size
    data = list(img.get_flattened_data())
    dark = [1 if p < threshold else 0 for p in data]
    visited = [False] * (w * h)
    comps: list[Component] = []

    for start in range(w * h):
        if not dark[start] or visited[start]:
            continue
        q = deque([start])
        visited[start] = True
        min_x = min_y = 10**9
        max_x = max_y = -1
        count = 0
        while q:
            j = q.popleft()
            x, y = j % w, j // w
            if x < min_x:
                min_x = x
            if x > max_x:
                max_x = x
            if y < min_y:
                min_y = y
            if y > max_y:
                max_y = y
            count += 1
            for dy in (-1, 0, 1):
                ny = y + dy
                if ny < 0 or ny >= h:
                    continue
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx = x + dx
                    if nx < 0 or nx >= w:
                        continue
                    ni = ny * w + nx
                    if dark[ni] and not visited[ni]:
                        visited[ni] = True
                        q.append(ni)
        comps.append(Component(count, min_x, min_y, max_x, max_y))
    return comps


def _is_text_like(c: Component) -> bool:
    """Heuristic filter: is this component likely part of dimension text?"""
    if c.count < MIN_COMPONENT_PIXELS or c.count > MAX_COMPONENT_PIXELS:
        return False
    if c.height < MIN_TEXT_HEIGHT or c.height > MAX_TEXT_HEIGHT:
        return False
    if c.width > MAX_TEXT_WIDTH:
        return False
    if c.width > MAX_ASPECT_RATIO * c.height:
        return False  # long thin run => dimension line, not text
    area = c.width * c.height
    if area > 0 and c.count / area > MAX_COMPONENT_DENSITY:
        return False  # near-solid blob => geometry
    return True


def _group_components(comps: list[Component]) -> list[TextGroup]:
    """Chain nearby text components into annotation groups.

    Handles both horizontal text (chars side by side) and vertical/rotated
    text (chars stacked). Chars of one annotation are close; different
    annotations are separated by at least a couple of character heights.
    """
    gap = MAX_GROUP_GAP * ANALYSIS_SCALE
    word_gap = MAX_WORD_GAP * ANALYSIS_SCALE
    v_gap = MAX_VERTICAL_TEXT_GAP * ANALYSIS_SCALE

    groups: list[TextGroup] = []
    remaining = list(comps)
    while remaining:
        seed = remaining.pop(0)
        members = [seed]
        min_x, min_y = seed.min_x, seed.min_y
        max_x, max_y = seed.max_x, seed.max_y
        changed = True
        while changed:
            changed = False
            for comp in list(remaining):
                # gap between the growing group bbox and this component
                gap_x = max(comp.min_x - max_x, min_x - comp.max_x)
                gap_y = max(comp.min_y - max_y, min_y - comp.max_y)
                # horizontal text: chars side by side, sharing a baseline
                overlap_y = min(max_y, comp.max_y) - max(min_y, comp.min_y)
                min_h = min(max_y - min_y + 1, comp.max_y - comp.min_y + 1)
                # word gaps must be relative to glyph size: two parallel
                # vertical text columns are ~8+ char widths apart.
                # Use glyph-height-relative limit (SPLIT_GAP_HEIGHTS * min_h)
                # capped at MAX_WORD_GAP, so chars of one annotation chain
                # while two separate annotations on the same baseline do not.
                gap_x_limit = min(word_gap, SPLIT_GAP_HEIGHTS * min_h)
                horizontal = (
                    gap_y <= gap
                    and gap_x <= gap_x_limit
                    and overlap_y >= MIN_OVERLAP_FRACTION * min_h
                )
                # vertical (rotated) text: chars stacked in one column
                overlap_x = min(max_x, comp.max_x) - max(min_x, comp.min_x)
                min_w = min(max_x - min_x + 1, comp.max_x - comp.min_x + 1)
                vertical = (
                    gap_x <= gap * 1.5
                    and gap_y <= v_gap
                    and overlap_x >= MIN_OVERLAP_FRACTION * min_w
                )
                if horizontal or vertical:
                    members.append(comp)
                    remaining.remove(comp)
                    min_x = min(min_x, comp.min_x)
                    min_y = min(min_y, comp.min_y)
                    max_x = max(max_x, comp.max_x)
                    max_y = max(max_y, comp.max_y)
                    changed = True
        groups.append(TextGroup(min_x, min_y, max_x, max_y, members))
    return groups


def _split_wide_group(grp: TextGroup) -> list[TextGroup]:
    """Split one horizontally-merged group back into separate annotations.

    A dimension annotation's own glyphs are separated by sub-glyph gaps, but
    a wide group may actually be TWO independent texts on the same baseline
    (e.g. "Φ0.750 ±0.001 INCH" then "1.500 ±0.002 INCH" 44px apart).
    If the members, in x-order, have a single gap far larger than their own
    glyph pitch, we cut there and return two groups.

    Only splits when there is a clear outlier gap (much bigger than the
    median inter-glyph gap of the group) so we never split a normal
    annotation.
    """
    if len(grp.members) < 4:
        return [grp]
    order = sorted(grp.members, key=lambda c: (c.min_x, c.min_y))
    # Inter-member center gaps, in analysis space.
    gaps = []
    for i in range(1, len(order)):
        dx = (order[i].min_x + order[i].max_x) / 2 - (
            order[i - 1].min_x + order[i - 1].max_x
        ) / 2
        gaps.append(dx)
    if not gaps:
        return [grp]
    med = sorted(gaps)[len(gaps) // 2]
    if med <= 0:
        return [grp]
    # Find the largest gap that is > ~2x the typical glyph pitch and > ~2.4
    # glyph-heights. Use median glyph height of the group for the height ref.
    gh = sorted(c.height for c in grp.members)[len(grp.members) // 2]
    height_ref = max(1.0, gh)
    cut_idx = None
    best = 0.0
    for i, g in enumerate(gaps):
        if g > 2.0 * med and g > SPLIT_GAP_HEIGHTS * height_ref and g > best:
            best = g
            cut_idx = i
    if cut_idx is None:
        return [grp]
    left = order[: cut_idx + 1]
    right = order[cut_idx + 1 :]

    def make(members):
        return TextGroup(
            min(m.min_x for m in members),
            min(m.min_y for m in members),
            max(m.max_x for m in members),
            max(m.max_y for m in members),
            list(members),
        )

    return [make(left), make(right)]


def _is_title_block(grp: TextGroup, image_height: int) -> bool:
    """True if a group looks like prose/title-block text, not a dimension.

    Title blocks (e.g. "SUPPORT BRACKET - INCH TEST") are many small glyphs
    on one baseline spanning a wide x-range. A dimension annotation is
    shorter and usually not wider than ~160px. To avoid dropping a genuinely
    wide dimension, a group only qualifies when it is wide, very wide in
    aspect, single-baseline, and (when merely borderline) sits low in the
    image where title blocks live.

    ``image_height`` must be supplied in the SAME space as the group coords
    (original px).
    """
    if len(grp.members) < TITLE_MIN_MEMBERS:
        return False
    width = grp.max_x - grp.min_x
    height = grp.max_y - grp.min_y
    if width <= 0 or height <= 0:
        return False
    aspect = width / height
    if width < TITLE_MIN_WIDTH or aspect < TITLE_MIN_ASPECT:
        return False
    if height > TITLE_MAX_HEIGHT:
        # Too tall to be a one-line title block: could be a stacked dim.
        return False
    cy = (grp.min_y + grp.max_y) / 2.0
    if cy < TITLE_BORDER_FRACTION * image_height:
        # It is a wide group but not in the border/title zone; keep it as a
        # candidate (could be a legitimately wide dimension).
        return False
    return True


def _title_clusters(groups: list[TextGroup], image_height: int) -> set[int]:
    """Return indexes of groups that belong to a title-block cluster.

    A title block is often split into word-sized groups by _group_components
    (word gaps exceed the intra-annotation gap limit), so no single piece is
    wide enough to pass _is_title_block. Merge groups that sit on the same
    baseline and are horizontally adjacent (within a word-gap) into a
    cluster, then test the cluster as a whole. If it reads as a title block,
    mark EVERY member of that cluster for removal.

    Groups are only chained when they are genuinely close (a contiguous run
    of prose). Far-apart groups on the same baseline stays separate, so a
    real dimension near the title block is never swept up with it.
    """
    if not groups:
        return set()
    # Group by y-baseline band (within a word-height of each other).
    by_y: list[list[int]] = []
    band_max_y: list[float] = []
    order = sorted(range(len(groups)), key=lambda i: (groups[i].min_y, groups[i].min_x))
    for i in order:
        g = groups[i]
        placed = False
        for bi, band in enumerate(by_y):
            if g.min_y <= band_max_y[bi] + 6:  # ~same baseline
                band.append(i)
                band_max_y[bi] = max(band_max_y[bi], g.max_y)
                placed = True
                break
        if not placed:
            by_y.append([i])
            band_max_y.append(g.max_y)
    removed: set[int] = set()
    for band in by_y:
        if len(band) < 2:
            continue
        band_sorted = sorted(band, key=lambda i: groups[i].min_x)
        # Segment the band into contiguous chains: a chain continues only
        # while the next group starts within a word-gap of the running end.
        # A gap clearly bigger than a word separates two distinct clusters.
        CHAIN_GAP = 60
        chains: list[list[int]] = []
        cur: list[int] = [band_sorted[0]]
        for i in band_sorted[1:]:
            if groups[i].min_x - groups[cur[-1]].max_x <= CHAIN_GAP:
                cur.append(i)
            else:
                chains.append(cur)
                cur = [i]
        chains.append(cur)
        for chain in chains:
            if len(chain) < 2:
                continue
            cmin_x = min(groups[i].min_x for i in chain)
            cmin_y = min(groups[i].min_y for i in chain)
            cmax_x = max(groups[i].max_x for i in chain)
            cmax_y = max(groups[i].max_y for i in chain)
            nmembers = sum(len(groups[i].members) for i in chain)
            merged = TextGroup(cmin_x, cmin_y, cmax_x, cmax_y, [0] * nmembers)
            if _is_title_block(merged, image_height):
                removed.update(chain)
    return removed


def _distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def _is_snap_target(grp: TextGroup) -> bool:
    """True if this group could be the printed text of a dimension.

    ``grp.members`` are in ANALYSIS space (2x), so the glyph thresholds are
    scaled here.
    """
    if len(grp.members) < MIN_GROUP_GLYPHS:
        return False
    min_height = GLYPH_MIN_HEIGHT_PX * ANALYSIS_SCALE
    for comp in grp.members:
        if comp.height < min_height:
            continue
        aspect = comp.width / comp.height if comp.height else 0.0
        if GLYPH_ASPECT_MIN <= aspect <= GLYPH_ASPECT_MAX:
            return True
    return False


def find_text_groups(image_path: str | Path) -> list[TextGroup]:
    """Return all text-like component groups found in the drawing (1x coords)."""
    img = _load_grayscale(image_path)
    # Upscale for analysis so small glyphs form solid components
    img = img.resize(
        (img.width * ANALYSIS_SCALE, img.height * ANALYSIS_SCALE), Image.LANCZOS
    )
    threshold = _adaptive_threshold(img)
    comps = [c for c in _find_components(img, threshold) if _is_text_like(c)]
    groups = [
        g for g in _group_components(comps) if g.height >= MIN_TEXT_HEIGHT * ANALYSIS_SCALE
    ]
    # Convert one analysis-space group to original-space coords.
    def _orig(g: TextGroup) -> TextGroup:
        return TextGroup(
            g.min_x // ANALYSIS_SCALE,
            g.min_y // ANALYSIS_SCALE,
            g.max_x // ANALYSIS_SCALE,
            g.max_y // ANALYSIS_SCALE,
            g.members,
        )
    # Drop title-block / prose-like groups so they cannot steal a dimension
    # box. Detect on the FULL group BEFORE splitting: a title block is a wide
    # run of glyphs (e.g. "BASEPLATE - MM TEST") that, if split first into
    # word-sized pieces, would fall below the width/member thresholds here.
    img_h = img.height // ANALYSIS_SCALE
    # Remove title-block pieces: a wide group on its own, OR a same-baseline
    # cluster of word-sized groups that together read as a title block.
    # Title detection must use ORIGINAL-space coords (thresholds are in px),
    # while _split_wide_group below needs ANALYSIS-space members. So build
    # an original-space mirror purely for title detection.
    orig_mirror = [_orig(g) for g in groups]
    removed = _title_clusters(orig_mirror, img_h)
    groups = [
        g for i, g in enumerate(groups)
        if i not in removed and not _is_title_block(orig_mirror[i], img_h)
    ]
    # Split horizontally-merged groups (two separate annotations joined on
    # one baseline) back into individual annotations.
    split: list[TextGroup] = []
    for g in groups:
        split.extend(_split_wide_group(g))
    groups = split
    # Drop groups that cannot be a dimension annotation: single blobs (dashes,
    # arrowheads, the section letter "A") and runs with no glyph-shaped member
    # (centreline crossings). Keep everything when the filter would empty the
    # list, so a sheet with one tiny annotation can still be snapped.
    targets = [g for g in groups if _is_snap_target(g)]
    if targets:
        groups = targets
    # Map back to original image space
    return [_orig(g) for g in groups]


# --------------------------------------------------------------------------- #
# Assignment: match LLM bboxes to text groups


def group_bbox(
    g: TextGroup, image_width: int, image_height: int, padding: int = BBOX_PADDING
) -> BoundingBox:
    """Padded bounding box of a text group in image coordinates."""
    return BoundingBox(
        top_left_x=max(0.0, g.min_x - padding),
        top_left_y=max(0.0, g.min_y - padding),
        bottom_right_x=min(float(image_width), g.max_x + padding),
        bottom_right_y=min(float(image_height), g.max_y + padding),
    )


def candidate_groups(
    bbox: BoundingBox, groups: list[TextGroup]
) -> list[tuple[float, int]]:
    """Candidate text groups near a bbox: (distance, group_index), sorted."""
    return _candidates(bbox, groups, 0, 0)


def _candidates(
    bbox: BoundingBox, groups: list[TextGroup], image_width: int, image_height: int
) -> list[tuple[float, int]]:
    """Candidate groups near a bbox: (distance, group_index), sorted."""
    cx, cy = bbox.center
    out = []
    for gi, g in enumerate(groups):
        if abs(g.center[0] - cx) > MAX_MATCH_DISTANCE:
            continue
        if abs(g.center[1] - cy) > MAX_MATCH_DISTANCE:
            continue
        dist = _distance(g.center, (cx, cy))
        if dist <= MAX_MATCH_DISTANCE:
            out.append((dist, gi))
    out.sort(key=lambda t: (t[0], t[1]))
    return out


# Cost bookkeeping for the assignment: a real match is always cheaper than
# leaving a box unmatched, and an impossible pair is never chosen.
_UNMATCHED_COST = 1000.0
_FORBIDDEN_COST = 1e6


@dataclass
class Match:
    """How one model box was matched to the text actually printed there."""

    bbox: BoundingBox
    found: bool
    group_index: int | None = None
    distance: float = float("inf")
    overlap: float = 0.0
    cost: float = float("inf")
    norm: float = float("inf")
    # Cost of the second-best candidate. Close to ``cost`` => ambiguous pick.
    rival_cost: float = float("inf")


def _rect_iou(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    """IoU of two (x1, y1, x2, y2) rectangles."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _match_radius(bbox: BoundingBox) -> float:
    """Search radius for one box, scaled to the box (≈ text) size."""
    w = max(1.0, bbox.bottom_right_x - bbox.top_left_x)
    h = max(1.0, bbox.bottom_right_y - bbox.top_left_y)
    scale = max(h, w / 3.0, 12.0)
    return max(MATCH_RADIUS_MIN, min(MATCH_RADIUS_MAX, MATCH_RADIUS_FACTOR * scale))


def _match_candidates(
    bbox: BoundingBox, groups: list[TextGroup]
) -> list[tuple[float, int, float, float, float]]:
    """Plausible snap targets: (cost, group_index, distance, overlap, norm).

    Cost is the centre distance normalised by glyph size, discounted when the
    box and the text actually overlap — that is what makes a slightly-off but
    correctly-targeted box beat a closer, unrelated piece of text.
    """
    radius = _match_radius(bbox)
    rect = (
        bbox.top_left_x,
        bbox.top_left_y,
        bbox.bottom_right_x,
        bbox.bottom_right_y,
    )
    box_h = max(1.0, rect[3] - rect[1])
    out: list[tuple[float, int, float, float, float]] = []
    for gi, g in enumerate(groups):
        dist = _distance(g.center, bbox.center)
        if dist > radius:
            continue
        overlap = _rect_iou(rect, (g.min_x, g.min_y, g.max_x, g.max_y))
        norm = dist / max(10.0, 0.5 * (g.height + box_h))
        out.append((norm * (1.0 - OVERLAP_BONUS * overlap), gi, dist, overlap, norm))
    out.sort(key=lambda t: (t[0], t[1]))
    return out


def _hungarian(cost: list[list[float]]) -> list[tuple[int, int]]:
    """Minimum-cost assignment for a rectangular matrix (e-maxx / JV).

    Returns (row, column) pairs. The algorithm needs at least as many columns
    as rows, so a taller matrix is transposed first — otherwise it cannot find
    an augmenting path and spins forever.
    """
    n = len(cost)
    m = len(cost[0]) if n else 0
    if n == 0 or m == 0:
        return []
    if n > m:
        flipped = [[cost[i][j] for i in range(n)] for j in range(m)]
        return [(i, j) for j, i in _hungarian(flipped)]
    u = [0.0] * (n + 1)
    v = [0.0] * (m + 1)
    p = [0] * (m + 1)  # p[j] = 1-based row matched to column j
    way = [0] * (m + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [float("inf")] * (m + 1)
        used = [False] * (m + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = float("inf")
            j1 = 0
            for j in range(1, m + 1):
                if used[j]:
                    continue
                cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta = minv[j]
                    j1 = j
            for j in range(m + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    return [(p[j] - 1, j - 1) for j in range(1, m + 1) if p[j] > 0]


def refine_bboxes_detailed(
    bboxes: list[BoundingBox],
    groups: list[TextGroup],
    image_width: int,
    image_height: int,
) -> list[Match]:
    """Snap every box to the text it points at, one text per box.

    Matching is GLOBAL and one-to-one: two boxes can never claim the same piece
    of text (the old per-row-band matching could, because a band was built from
    the raw box coordinates and two boxes 50px apart landed in different bands,
    producing a duplicate box plus a lost annotation).
    """
    n = len(bboxes)
    m = len(groups)
    cands = [_match_candidates(b, groups) for b in bboxes]

    assigned: dict[int, int] = {}
    if n and m:
        # Columns 0..m-1 are the text groups; columns m..m+n-1 are one private
        # "leave this box unmatched" option per box, priced above any real match
        # but below a forbidden pair.
        width = m + n
        cost = [[_FORBIDDEN_COST] * width for _ in range(n)]
        for i, cl in enumerate(cands):
            for c, gi, _dist, _ov, _norm in cl:
                cost[i][gi] = c
            cost[i][m + i] = _UNMATCHED_COST
        for i, j in _hungarian(cost):
            if j < m and cost[i][j] < _UNMATCHED_COST:
                assigned[i] = j

    results: list[Match] = []
    for i, bbox in enumerate(bboxes):
        gi = assigned.get(i)
        if gi is None:
            results.append(Match(bbox=bbox, found=False))
            continue
        detail = next((c for c in cands[i] if c[1] == gi), None)
        cost, _gi, dist, overlap, norm = (
            detail if detail else (float("inf"), gi, 0.0, 0.0, float("inf"))
        )
        rivals = [c[0] for c in cands[i] if c[1] != gi]
        results.append(
            Match(
                bbox=group_bbox(groups[gi], image_width, image_height),
                found=True,
                group_index=gi,
                distance=dist,
                overlap=overlap,
                cost=cost,
                norm=norm,
                rival_cost=min(rivals) if rivals else float("inf"),
            )
        )
    return results


def refine_bboxes(
    bboxes: list[BoundingBox],
    groups: list[TextGroup],
    image_width: int,
    image_height: int,
) -> list[tuple[BoundingBox, bool]]:
    """Snap LLM bounding boxes to the nearest real text groups.

    Returns:
        List of (refined bbox, found_text). ``found_text`` is False when no
        text-like pixels exist near the LLM location.
    """
    return [
        (m.bbox, m.found)
        for m in refine_bboxes_detailed(bboxes, groups, image_width, image_height)
    ]


# Backwards-compatible single-bbox helper (used by tests)
def refine_bbox(
    bbox: BoundingBox,
    groups: list[TextGroup],
    image_width: int,
    image_height: int,
) -> tuple[BoundingBox, bool]:
    return refine_bboxes([bbox], groups, image_width, image_height)[0]
