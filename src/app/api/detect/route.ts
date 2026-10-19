import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { withBasePath } from "@/lib/basePath";
import { findUpload, getUploadsDir } from "@/lib/uploadStore";
import { ENV_FILE, projectEnv } from "@/lib/env";

const execFileAsync = promisify(execFile);

// All paths are local to the web app — no outside dependencies.
const WEB_ROOT = process.cwd();
const TESTS_DIR = path.join(WEB_ROOT, "images", "tests");
const OUTPUT_DIR = path.join(WEB_ROOT, "output", "test_results");
const PYTHON_SRC = path.join(WEB_ROOT, "python");

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

// Strict single-flight guard: only ONE detection may run at a time.
// Concurrent detections (e.g. two browser tabs) would each spawn a Python
// process and double/triple the LLM call rate, tripping gateway per-minute
// quotas (symptom: "first image works, the next ones always time out").
// The Node process is single-threaded, so a plain boolean flag is a safe
// mutex here — requests are serialized at the event loop level, and there is
// no await between the check and the set.
let detectionInFlight = false;

export async function POST(request: NextRequest) {
  // The request body can only be read once — parse here and pass down.
  let body: { filename?: string; channel?: number } = {};
  try {
    body = await request.json();
  } catch {
    // handled by runDetection's validation
  }
  return runDetection(body);
}

async function runDetection(body: {
  filename?: string;
  channel?: number;
}) {
  try {
    const { filename, channel } = body;
    // Normalize channel to a safe integer (1 or 2); default to channel 1.
    const channelVal = channel === 2 ? 2 : 1;

    if (!filename) {
      return NextResponse.json(
        { error: "Missing filename" },
        { status: 400 }
      );
    }

    if (detectionInFlight) {
      return NextResponse.json(
        { error: "已有检测正在进行，请等待完成后再试。" },
        { status: 429 }
      );
    }
    detectionInFlight = true;

    // Sanitize
    const safeName = path.basename(filename);
    if (safeName !== filename || filename.includes("..")) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    // Resolve the image: uploaded files (unique storage names) take
    // precedence, otherwise fall back to the bundled test drawings.
    const uploadMeta = findUpload(safeName);
    const imagePath = uploadMeta
      ? path.join(getUploadsDir(), uploadMeta.storageName)
      : path.join(TESTS_DIR, safeName);
    if (!fs.existsSync(imagePath)) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    const stem = path.parse(safeName).name;
    const resultPath = path.join(OUTPUT_DIR, `${stem}_result.json`);
    const annotatedPath = path.join(OUTPUT_DIR, `${stem}_annotated.png`);

    const pythonCmd = resolvePython();

    try {
      const { stdout, stderr } = await execFileAsync(
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

detector = DrawingDetector(channel=${channelVal})
result = detector.detect(Path('${toPosix(imagePath)}'))
print(f'CHANNEL={detector._active_num}', file=sys.stderr)
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
          // 6 minutes: the Python side hard-caps each LLM call (probe 5s,
          // extract 45s, crop-read 15s, failover doubling at most) and
          // enforces a 240s TOTAL LLM budget per run, plus CV/startup
          // overhead, so a run should always exit well under this ceiling.
          // This timeout is only a safety net for pathological cases.
          timeout: 360000,
          env: { ...projectEnv, ...process.env },
        }
      );

      const result = JSON.parse(stdout.trim());
      // Which channel actually served the detection (the Python side fails
      // over automatically when the selected channel is slow).
      const chMatch = stderr.match(/CHANNEL=(\d)/);
      const channelUsed = chMatch ? parseInt(chMatch[1], 10) : channelVal;
      // Surface the Python side's [llm] call-duration/token logs (stderr)
      // into journald so LLM usage is observable on successful runs too.
      if (stderr.trim()) {
        console.log(stderr.trim());
      }
      return NextResponse.json({
        status: "detected",
        result,
        channelUsed,
        // Cache-busting param so the browser always fetches the fresh image
        annotatedUrl: withBasePath(`/api/annotated?name=${encodeURIComponent(
          safeName
        )}&t=${Date.now()}`),
      });
    } catch (execError: unknown) {
      const errMsg =
        execError instanceof Error ? execError.message : String(execError);
      console.error("Detection failed:", errMsg);
      // Surface the FINAL diagnostic to the UI if present. Covers both
      // "LLM 调用超时…" (starts with "LLM ") and "当前LLM通道不可用…"
      // (no space before LLM); the last match is what actually aborted the
      // run.
      const chMatch = errMsg.match(/(?:当前)?LLM[^\n]*/g);
      let errorMsg: string;
      if (chMatch) {
        errorMsg = chMatch[chMatch.length - 1];
      } else if (/SIGTERM|killed|ETIMEDOUT/i.test(errMsg)) {
        // The Node-side exec timeout killed the Python process — the
        // Python-side budgets should make this rare.
        errorMsg = "检测超时（进程被终止），请重试或稍后再试。";
      } else {
        errorMsg = "Detection failed";
      }
      return NextResponse.json(
        { error: errorMsg, details: errMsg },
        { status: 500 }
      );
    } finally {
      detectionInFlight = false;
    }
  } catch (error) {
    console.error("API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
