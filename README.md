# Drawing Detection — Web Application

A **fully self-contained** Next.js fullstack application that showcases a
Vision-LLM-powered engineering-drawing dimension extraction pipeline. A user
selects one of the bundled test drawings, clicks **Run Detection**, and the app
calls a bundled Python detection engine (Vision LLM + CV refinement), then
displays the detection results table and the drawing annotated with
color-coded bounding boxes.

> **Self-contained:** everything the app needs lives inside this `web/` folder —
> test images, the Python detection engine, the API key config, fonts, and
> runtime output. There are no references to parent directories or external
> folders.

---

## Quick Start

```bash
# 1. Node dependencies
npm install

# 2. (Required for "Run Detection") Python 3.12+ with the engine's packages
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # Windows
# .venv/bin/pip install -r requirements.txt       # macOS / Linux

# 3. API key config (already present as .env if copied; otherwise)
cp .env.example .env   # then set LLM_API_KEY

# 4. Run
npm run dev            # http://localhost:3000
```

**Viewing works with zero setup** (browse drawings, see the UI). **Run
Detection** additionally needs Python deps + an API key + network access to the
LLM endpoint.

---

## What the App Does

- **Clean start** — On launch, no detection results and no bounding boxes are
  shown. Every drawing displays as its clean original; the sidebar shows
  "No results".
- **On-demand detection** — Clicking **Run Detection** executes the real Python
  detection pipeline for the selected drawing (LLM extraction → regex parsing →
  CV box refinement → annotation render). When it completes, the results table
  and bounding boxes appear.
- **Image viewer** — Defaults to an **Annotated** view (clean original until a
  detection has run), with toggles for **Original** and **Side by Side**.
- **Results table** — Per-dimension: raw text, nominal value, tolerance, unit,
  dimension type (color-coded), feature classification, confidence, review flag.

---

## Architecture & Data Flow

```
Browser
  │  selects drawing, clicks "Run Detection"
  ▼
Next.js API Route  POST /api/detect
  │  spawns Python (web/.venv if present, else system `python`)
  │  loads web/.env (LLM_API_KEY …), sets PYTHONPATH=web/python
  │  runs an inline Python script
  ▼
Bundled engine  web/python/drawing_detection/
  ├─ detector.py   Vision LLM extraction (OpenAI-compatible, JSON mode)
  ├─ parser.py     regex parsing, validation, defensive numeric coercion
  ├─ classifier.py feature classification heuristics
  ├─ locator.py    CV connected-component text localization (Pillow)
  ├─ visualizer.py draws bounding boxes → annotated PNG
  └─ prompts/      LLM prompts (extraction / retry / crop verification)
  │
  │  writes web/output/test_results/<stem>_result.json + _annotated.png
  ▼
API responds  { status:"detected", result:{...}, annotatedUrl:"/api/annotated?...&t=<ts>" }
  │
  ▼
Browser re-renders: results table + annotated image (cache-busted URL)
```

### Key design decisions

- **Detection runs server-side** via `child_process.execFile` (2-minute
  timeout). The inline script mirrors `detector.detect()` + `draw_bounding_boxes()`.
- **No caching of results at launch** — the UI intentionally starts empty so
  staff see only what was actually detected in the current session.
- **Cache-busted annotated URL** — `?t=<timestamp>` plus `Cache-Control:
  no-store` on `/api/annotated` ensures fresh boxes after every run.
- **Robust parser** — the LLM sometimes returns strings (`"tolerance": "+/-0.03"`)
  or `null`; `_coerce_number()` in `parser.py` normalizes these so a single bad
  field never crashes a run.

---

## Directory Structure

```
web/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── images/route.ts     GET  list drawings (clean start: no results)
│   │   │   ├── image/route.ts      GET  serve original drawing PNG
│   │   │   ├── annotated/route.ts  GET  serve annotated PNG (falls back to original)
│   │   │   └── detect/route.ts     POST run detection, return result + image URL
│   │   ├── globals.css             Claude design-system tokens + self-hosted fonts
│   │   ├── layout.tsx              root layout (fonts are bundled, no CDN)
│   │   └── page.tsx                main app (sidebar + viewer + results)
│   ├── components/
│   │   ├── Header.tsx              top navigation
│   │   ├── ImageSelector.tsx       sidebar list of test drawings
│   │   ├── ImageComparison.tsx     annotated / original / side-by-side viewer
│   │   └── DimensionTable.tsx      detection results table
│   └── lib/
│       ├── types.ts                TypeScript interfaces (result schema)
│       └── constants.ts            design tokens + dimension colors
├── images/
│   ├── tests/                      test drawings + reference results
│   │   ├── test-001.png … test-005.png
│   │   └── tests_results.json      reference/expected data (not shown at launch)
│   └── reference/                  source reference drawings
├── python/
│   └── drawing_detection/          bundled Python detection engine (copied from
│                                   the parent project, kept in sync)
├── output/
│   └── test_results/               runtime artifacts (regenerated on demand:
│                                   <stem>_result.json, <stem>_annotated.png)
├── public/
│   └── fonts/                      self-hosted woff2 (Cormorant Garamond, Inter,
│                                   JetBrains Mono) — no external font CDN
├── .env                            LLM config (git-ignored; see .env.example)
├── requirements.txt                Python deps for the bundled engine
└── package.json                    Node deps & scripts
```

---

## API Reference

| Endpoint | Method | Body / Query | Returns |
|---|---|---|---|
| `/api/images` | GET | — | `{ images: [{ filename, displayName, thumbnailUrl, fullUrl, result: null, annotatedUrl: null }] }` — intentionally empty results at launch |
| `/api/image?name=test-001.png` | GET | `name` (filename only, sanitized) | PNG bytes of the original drawing |
| `/api/annotated?name=test-001.png[&t=ts]` | GET | `name`, optional `t` cache-buster | Annotated PNG if it exists, else the original (clean) PNG |
| `/api/detect` | POST | `{ filename: "test-001.png" }` | `{ status: "detected", result: <DetectionResult>, annotatedUrl: "/api/annotated?name=…&t=<ts>" }` or `{ error, details }` |

All routes sanitize `name` with `path.basename` and reject `..` / paths.
All filesystem paths derive from `process.cwd()` (the `web/` folder) — no
parent-directory access.

### DetectionResult schema

```jsonc
{
  "image_path": "test-001.png",
  "image_width": 1020,
  "image_height": 540,
  "dimensions": [
    {
      "item_id": "dim_001",
      "raw_text": "75 ±0.02 mm",
      "nominal_value": 75.0,
      "tolerance": 0.02,            // symmetric ±, or null
      "tolerance_plus": 0.02,       // asymmetric, or null
      "tolerance_minus": -0.02,     // asymmetric, or null
      "quantity": 1,                // e.g. 4 for "4X Φ10"
      "unit": "mm",                 // mm | inch | degree | unknown
      "dimension_type": "linear",   // linear | diameter | angle | radius | unknown
      "feature_classification": "Edge-to-Edge",
      "confidence": 0.9,            // 0.0 – 1.0
      "bbox": { "top_left_x": 287.0, "top_left_y": 41.0,
                "bottom_right_x": 407.0, "bottom_right_y": 62.0 },
      "needs_review": false
    }
  ],
  "total_detected": 5,
  "needs_review_count": 1
}
```

---

## Design System (Claude-inspired)

Defined in `src/app/globals.css` as CSS custom properties, plus `src/lib/constants.ts`:

- **Canvas** — warm cream `#faf9f5`; **coral primary** `#cc785c` (CTAs, accents)
- **Surfaces** — cream cards `#efe9de`, dark product surfaces `#181715`
- **Typography** — Cormorant Garamond (display serif), Inter (body sans),
  JetBrains Mono (data/code) — all self-hosted under `public/fonts/`
- **Dimension box colors** (matches `visualizer.py`):
  green = linear, red = diameter, blue = angle, orange = radius,
  orange outline = needs review

---

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `LLM_API_KEY` | — (required) | API key for the Vision LLM |
| `LLM_BASE_URL` | `https://llm.stgaiserver.com/v1` | OpenAI-compatible endpoint |
| `LLM_MODEL` | `/models/qwen3.6-35b-a3b.gguf` | Model ID |

`web/.env` is git-ignored — on a fresh machine, copy `.env.example` and fill it in.

---

## Python Environment

- **Interpreter resolution** (`detect/route.ts` `resolvePython()`): checks
  `web/.venv/Scripts/python.exe` (Windows) → `web/.venv/bin/python` (POSIX) →
  falls back to `python` on PATH.
- **Dependencies** (`requirements.txt`): `openai`, `pydantic`,
  `python-dotenv`, `Pillow`.
- **Sync note:** the bundled engine (`web/python/`) is a copy of the parent
  project's `src/drawing_detection/`. If the parent changes, re-copy and keep
  the `parser.py` robustness fixes (`_coerce_number`) and `classifier.py` null
  handling in both places.

---

## Test Drawings

`images/tests/` contains 5 drawings exercising different extraction cases:

| File | Content |
|---|---|
| `test-001.png` | Linear dims with tolerances (`75 ±0.02 mm`), `2X Φ12` |
| `test-002.png` | Inch units (`3.250 ±0.005 INCH`, `Φ0.750 ±0.001 INCH`) |
| `test-003.png` | Multiplier / holes (`4X Φ10 ±0.05`, `Φ120 mm` — "CIRCULAR FLANGE - MULTIPLIER TEST") |
| `test-004.png` | Angles + radii (`120°`, `R35 ±0.1`) |
| `test-005.png` | Asymmetric tolerances (`25 +0.10/-0.05`, `12.5 +0.00/-0.02`) |

`tests_results.json` holds reference/expected data (used by the parent
project's test runner); the web app does **not** display it at launch.

---

## Troubleshooting

- **Detection fails with "API key required"** → `web/.env` missing/empty; copy
  from `.env.example` and set `LLM_API_KEY`.
- **Detection fails / times out** → confirm Python deps installed
  (`pip install -r requirements.txt`) and the server can reach `LLM_BASE_URL`.
- **No boxes after Run Detection** → the annotated PNG is written to
  `web/output/test_results/`; if it's absent, the API errored — check the
  Next.js server console for the Python traceback.
- **LLM returns odd strings** (`"+/-0.03"`, `null` values) → handled by
  `parser.py::_coerce_number`; if you see a pydantic `ValidationError`, the
  engine copy is out of sync with the parent project's fixes.

---

## Production Deployment

```bash
npm run build
npm start            # serves on :3000
```

Because the app is self-contained, the whole `web/` folder can be copied to a
server; only the Python venv + `.env` need to be (re)created there.
