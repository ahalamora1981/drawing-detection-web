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

# Refinement search window: candidates within this distance of the LLM
# bbox center are considered (px, original space)
MAX_MATCH_DISTANCE = 160
BBOX_PADDING = 3                 # px added around the found text

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


def _monotone_assign(
    bbox_indices: list[int],
    cands: list[list[tuple[float, int]]],
    group_positions: list[int],
) -> dict[int, int]:
    """Assign bboxes to groups preserving left-to-right order.

    Returns {bbox_index: group_index}. Uses DP over (bbox, group) pairs with
    monotonicity (an earlier bbox cannot be assigned to a later group).
    """
    # bbox_indices sorted by center x; groups sorted by center x.
    n = len(bbox_indices)
    m = len(group_positions)
    INF = 10**9

    # cost[i][j] = distance if group j is a candidate for bbox i
    cost = [[INF] * m for _ in range(n)]
    for i, bi in enumerate(bbox_indices):
        for dist, gi in cands[bi]:
            if gi in group_positions:
                cost[i][group_positions.index(gi)] = dist

    # dp[i][j]: min cost assigning first i bboxes with bbox i-1 -> group j
    dp = [[INF] * m for _ in range(n)]
    parent = [[None] * m for _ in range(n)]
    for j in range(m):
        dp[0][j] = cost[0][j]
    for i in range(1, n):
        best_prev = INF
        best_j = None
        for j in range(m):
            # dp[i][j] uses min over dp[i-1][j'] with j' < j (strictly)
            if cost[i][j] < INF and best_prev < INF:
                dp[i][j] = cost[i][j] + best_prev
                parent[i][j] = best_j
            if dp[i - 1][j] < best_prev:
                best_prev = dp[i - 1][j]
                best_j = j
    # best final
    best_cost, best_j = INF, None
    for j in range(m):
        if dp[n - 1][j] < best_cost:
            best_cost, best_j = dp[n - 1][j], j
    if best_j is None:
        return {}
    assignment: dict[int, int] = {}
    j = best_j
    for i in range(n - 1, -1, -1):
        assignment[bbox_indices[i]] = group_positions[j]
        j = parent[i][j] if parent[i][j] is not None else j
        if j is None:
            break
    return assignment


def refine_bboxes(
    bboxes: list[BoundingBox],
    groups: list[TextGroup],
    image_width: int,
    image_height: int,
) -> list[tuple[BoundingBox, bool]]:
    """
    Snap LLM bounding boxes to the nearest real text groups.

    Returns:
        List of (refined bbox, found_text). ``found_text`` is False when no
        text-like pixels exist near the LLM location (caller should flag the
        dimension for review).
    """
    cands = [_candidates(b, groups, image_width, image_height) for b in bboxes]
    results: list[tuple[BoundingBox, bool]] = []

    # Partition bboxes into y-bands: annotations that are vertically close
    # are matched jointly (order-preserving) so adjacent parallel dimensions
    # cannot both grab the same text group. Well-separated bands (e.g. a
    # caption at the bottom of the drawing) stay independent.
    order_by_y = sorted(
        range(len(bboxes)), key=lambda i: (bboxes[i].center[1], bboxes[i].center[0])
    )
    bands: list[list[int]] = []
    band_max_y: list[float] = []
    for i in order_by_y:
        bbox = bboxes[i]
        placed = False
        for bi, band in enumerate(bands):
            if bbox.top_left_y <= band_max_y[bi] + BAND_MERGE_GAP:
                band.append(i)
                band_max_y[bi] = max(band_max_y[bi], bbox.bottom_right_y)
                placed = True
                break
        if not placed:
            bands.append([i])
            band_max_y.append(bbox.bottom_right_y)

    assigned: dict[int, int] = {}
    for band in bands:
        if not band:
            continue
        # groups this band can see, sorted by center (x, y)
        group_ids = sorted(
            {gi for i in band for _, gi in cands[i]},
            key=lambda gi: (groups[gi].center[0], groups[gi].center[1]),
        )
        if not group_ids:
            continue
        band_sorted = sorted(
            band, key=lambda i: (bboxes[i].center[0], bboxes[i].center[1])
        )
        assignment = _monotone_assign(band_sorted, cands, group_ids)
        assigned.update(assignment)

    for i, bbox in enumerate(bboxes):
        gi = assigned.get(i)
        if gi is None:
            results.append((bbox, False))
            continue
        results.append((group_bbox(groups[gi], image_width, image_height), True))
    return results


# Backwards-compatible single-bbox helper (used by tests)
def refine_bbox(
    bbox: BoundingBox,
    groups: list[TextGroup],
    image_width: int,
    image_height: int,
) -> tuple[BoundingBox, bool]:
    return refine_bboxes([bbox], groups, image_width, image_height)[0]
