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
npm run dev            # http://localhost:3000/dfm-demo
```

> **Base path:** the app runs under the `/dfm-demo` prefix (see
> `next.config.ts`). Visit `http://localhost:3000/dfm-demo`, **not** the bare
> root (`/` 404s by design). Client-side fetches are prefixed via the
> `NEXT_PUBLIC_BASE_PATH` env var — set it in `.env` to match:
>
> ```bash
> echo 'NEXT_PUBLIC_BASE_PATH=/dfm-demo' >> .env
> ```
>
> It must be present at build/run time or the upload/detect buttons will call
> unprefixed `/api/*` URLs and 404.

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

- **Detection runs server-side** via `child_process.execFile` (6-minute
  safety-net timeout). The inline script mirrors `detector.detect()` +
  `draw_bounding_boxes()`. The Python side enforces its own per-call caps
  (probe 5s / extract 45s / crop-read 15s) plus a 240s TOTAL LLM budget per
  run, so slow channels abort with a clear message instead of hitting the
  Node timeout.
- **Single-flight** — the `/api/detect` route rejects concurrent detection
  requests with HTTP 429, so two browser tabs can't double the LLM call
  rate and trip gateway per-minute quotas.
- **Manual channel switching** — the user picks `LLM（SaaS）` (channel 2,
  the default) or `LLM（本地）` (channel 1) in the UI, freely (no
  per-channel lock). Optional automatic failover is available via
  `LLM_FAILOVER=1` (a call that times out is retried once on the other
  channel); it is off by default.
- **PIN gate on every page refresh** — the whole app is protected by a PIN
  checked SERVER-SIDE (`APP_PIN` in `.env`): on every page load the UI
  shows a PIN pop-up that is validated via `/api/verify-pin`. Success is
  kept in memory only, so refreshing the page re-arms the pop-up. The PIN
  is never shipped to the client.
- **Thinking disabled per channel** — the STG server honors
  `enable_reasoning`, DashScope honors `enable_thinking`; the default
  per-channel extra body sends both (each server ignores the field it does
  not know). On DashScope this cuts extraction time from ~1–2 minutes of
  hidden reasoning tokens down to ~10–15s.
- **No caching of results at launch** — the UI intentionally starts empty so
  staff see only what was actually detected in the current session.
- **Cache-busted annotated URL** — `?t=<timestamp>` plus `Cache-Control:
  no-store` on `/api/annotated` ensures fresh boxes after every run.
- **Robust parser** — the LLM sometimes returns strings (`"tolerance": "+/-0.03"`)
  or `null`; `_coerce_number()` in `parser.py` normalizes these so a single bad
  field never crashes a run.
- **Verified localization** — every dimension's location is confirmed by
  reading the cropped text region after CV refinement; if the text doesn't
  match, a global search of all text regions relocates the box to the
  annotation actually printed there. This fixes bboxes that land on
  title-block prose (e.g. `"10 ±0.05"` mis-placed on `"BASEPLATE - MM TEST"`).
- **Title/prose exclusion** — the extraction prompt explicitly forbids
  treating titles, title blocks, notes, and part names as dimensions, and
  requires bboxes to tightly enclose the text at its true printed location
  (including vertical/rotated dimension text).

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
│   ├── sample-002.png              extra sample drawing (kept out of tests/,
│   │                               so it is not listed in the app sidebar)
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
├── .agents/skills/                 project-level agent skills (see “Agent Skills”)
├── skills-lock.json                pinned skill sources/hashes for .agents/skills
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
| `/api/detect` | POST | `{ filename: "test-001.png", channel: 1\|2 }` | `{ status: "detected", result: <DetectionResult>, channelUsed, annotatedUrl: "/api/annotated?name=…&t=<ts>" }` or `{ error, details }` |
| `/api/verify-pin` | POST | `{ pin: "…" }` | `{ ok: true }`, or 401 `{ ok: false, error }` — used by the UI's PIN pop-up on every page refresh |

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
| `LLM_1_API_KEY` | — (required) | API key for `LLM（本地）` — channel 1 (STG AI server) |
| `LLM_1_BASE_URL` | `https://llm.stgaiserver.com/v1` | OpenAI-compatible endpoint |
| `LLM_1_MODEL` | `/models/qwen3.6-35b-a3b.gguf` | Model ID |
| `LLM_2_API_KEY` | — (optional) | API key for `LLM（SaaS）` — channel 2, the UI default (Aliyun DashScope) |
| `LLM_2_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI-compatible endpoint |
| `LLM_2_MODEL` | `qwen3.8-flash` | Model ID |
| `APP_PIN` | — | PIN required to open the page (checked server-side; pop-up on every page refresh) |
| `LLM_FAILOVER` | `0` (off) | Set `1` to enable automatic failover to the other channel |
| `LLM_{1,2}_EXTRA_BODY` | `{"enable_reasoning": false, "enable_thinking": false}` | Per-channel extra request body (JSON) that disables model thinking |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | — (legacy) | Single-channel fallback values, still supported |

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

`images/sample-002.png` is an extra sample drawing kept outside `images/tests/`
(so it is not listed in the app sidebar); it can be used for manual testing.

---

## Agent Skills

The project ships agent skills under `.agents/skills/`, pinned by
`skills-lock.json` (installed from the `addyosmani/agent-skills` repository).
They let coding agents apply consistent workflows — debugging, git hygiene,
TDD, code review, and more. Reinstall or update them with your agent's skill
installer; treat the vendored copies as generated output rather than editing
them directly.

---

## Troubleshooting

- **Detection fails with "API key required"** → `web/.env` missing/empty; copy
  from `.env.example` and set `LLM_1_API_KEY` (and optionally `LLM_2_API_KEY`).
- **Detection fails / times out** → confirm Python deps installed
  (`pip install -r requirements.txt`). If you see "LLM 调用超时" the selected
  channel was slow at that moment — switch to the other channel in the UI and
  retry (or enable `LLM_FAILOVER=1` to do that automatically). If it happens
  constantly, check the STG server load (`bench_channel1.py`) and your
  DashScope quota.
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
npm start            # serves on :3000, app at /dfm-demo
```

Because the app is self-contained, the whole `web/` folder can be copied to a
server; only the Python venv + `.env` need to be (re)created there.
