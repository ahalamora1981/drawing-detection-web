import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// All paths are local to the web app — no outside dependencies.
const WEB_ROOT = process.cwd();
const TESTS_DIR = path.join(WEB_ROOT, "images", "tests");
const OUTPUT_DIR = path.join(WEB_ROOT, "output", "test_results");
const PYTHON_SRC = path.join(WEB_ROOT, "python");
const ENV_FILE = path.join(WEB_ROOT, ".env");

// Load .env file (web-local config)
function loadEnv(envPath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      vars[key] = value;
    }
  } catch {
    // .env not found, that's okay
  }
  return vars;
}

const projectEnv = loadEnv(ENV_FILE);

// Resolve the Python interpreter. Prefer a web-local venv; fall back to a
// system python (deps must then be installed via `pip install -r requirements.txt`).
function resolvePython(): string {
  const candidates = [
    path.join(WEB_ROOT, ".venv", "Scripts", "python.exe"),
    path.join(WEB_ROOT, ".venv", "bin", "python"), // POSIX layout
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "python";
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filename } = body;

    if (!filename) {
      return NextResponse.json(
        { error: "Missing filename" },
        { status: 400 }
      );
    }

    // Sanitize
    const safeName = path.basename(filename);
    if (safeName !== filename || filename.includes("..")) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    const imagePath = path.join(TESTS_DIR, safeName);
    if (!fs.existsSync(imagePath)) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    const stem = safeName.replace(/\.png$/, "");
    const resultPath = path.join(OUTPUT_DIR, `${stem}_result.json`);
    const annotatedPath = path.join(OUTPUT_DIR, `${stem}_annotated.png`);

    const pythonCmd = resolvePython();

    try {
      const { stdout } = await execFileAsync(
        pythonCmd,
        [
          "-c",
          `
import sys, json
from pathlib import Path

# Load .env from the web app root
try:
    from dotenv import load_dotenv
    load_dotenv('${toPosix(ENV_FILE)}')
except ImportError:
    env_path = Path('${toPosix(ENV_FILE)}')
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                import os; os.environ.setdefault(k.strip(), v.strip())

sys.path.insert(0, '${toPosix(PYTHON_SRC)}')
from drawing_detection.detector import DrawingDetector
from drawing_detection.visualizer import draw_bounding_boxes

detector = DrawingDetector()
result = detector.detect(Path('${toPosix(imagePath)}'))
output_path = Path('${toPosix(resultPath)}')
output_path.parent.mkdir(parents=True, exist_ok=True)
with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(result.to_dict(), f, indent=2, ensure_ascii=False)

annotated_path = Path('${toPosix(annotatedPath)}')
draw_bounding_boxes(Path('${toPosix(imagePath)}'), result, annotated_path)

print(json.dumps(result.to_dict()))
          `,
        ],
        {
          timeout: 120000, // 2 minute timeout
          env: { ...projectEnv, ...process.env },
        }
      );

      const result = JSON.parse(stdout.trim());
      return NextResponse.json({
        status: "detected",
        result,
        // Cache-busting param so the browser always fetches the fresh image
        annotatedUrl: `/api/annotated?name=${encodeURIComponent(
          safeName
        )}&t=${Date.now()}`,
      });
    } catch (execError: unknown) {
      const errMsg =
        execError instanceof Error ? execError.message : String(execError);
      console.error("Detection failed:", errMsg);
      return NextResponse.json(
        { error: "Detection failed", details: errMsg },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
