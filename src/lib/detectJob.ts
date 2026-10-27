// Spawns the two-stage Python engine and folds its output back into the run
// record. Long work never blocks an HTTP request: routes enqueue a job and
// the browser polls /api/runs/:id.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { projectEnv } from "./env";
import { findUpload, getUploadsDir } from "./uploadStore";
import { getRun, runDir, updateRun } from "./runStore";
import type { RunBox, RunState } from "./types";

const WEB_ROOT = process.cwd();
const PYTHON_SRC = path.join(WEB_ROOT, "python");
const TESTS_DIR = path.join(WEB_ROOT, "images", "tests");

const LOCATE_TIMEOUT_MS = 300_000;
const READ_TIMEOUT_MS = 400_000;

function resolvePython(): string {
  const candidates = [
    path.join(WEB_ROOT, ".venv", "Scripts", "python.exe"),
    path.join(WEB_ROOT, ".venv", "bin", "python"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "python";
}

export function resolveImagePath(
  filename: string
): { imagePath: string; source: "test" | "upload" } | null {
  const safeName = path.basename(filename);
  if (safeName !== filename || filename.includes("..")) return null;

  const upload = findUpload(safeName);
  if (upload) {
    const imagePath = path.join(getUploadsDir(), upload.storageName);
    return fs.existsSync(imagePath) ? { imagePath, source: "upload" } : null;
  }
  const imagePath = path.join(TESTS_DIR, safeName);
  return fs.existsSync(imagePath) ? { imagePath, source: "test" } : null;
}

/** Turn Python stderr into one human-readable line for the UI. */
function friendlyError(stderr: string, code: number | null): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^ERROR:\s*/.test(line)) {
      const msg = line.replace(/^ERROR:\s*/, "");
      if (/LLM/i.test(msg)) return msg;
      return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
    }
    if (/LLM/i.test(line) && /(超时|不可用|timeout|unavailable|密钥|API key)/i.test(line)) {
      return line;
    }
  }
  if (code === 3) return "AI 通道暂时不可用，请稍后重试或切换通道。";
  if (code === 4) return "识别引擎执行失败，请重试。";
  return "识别失败，请稍后重试。";
}

interface StageRun {
  code: number | null;
  stderr: string;
}

function runStageCli(
  args: string[],
  timeoutMs: number,
  onTick?: () => void
): Promise<StageRun> {
  return new Promise((resolve) => {
    const child = spawn(resolvePython(), ["-m", "drawing_detection.stage_cli", ...args], {
      env: { ...projectEnv, ...process.env, PYTHONPATH: PYTHON_SRC },
      cwd: WEB_ROOT,
    });

    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      // Surface engine logs in journald so LLM usage stays observable.
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });

    const ticker = onTick ? setInterval(onTick, 500) : null;
    const killer = setTimeout(() => {
      console.error("[stage] timeout, killing python process");
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      stderr += `\n${err.message}`;
    });
    child.on("close", (code) => {
      if (ticker) clearInterval(ticker);
      clearTimeout(killer);
      onTick?.();
      resolve({ code, stderr });
    });
    // Keep the compiler honest: stdout is only used for the final payload,
    // which the job reads from the artefact file instead.
    void stdout;
  });
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- //
// Stage 1 — locate
// --------------------------------------------------------------------------- //

export async function locateJob(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  const resolved = resolveImagePath(run.filename);
  if (!resolved) {
    updateRun(runId, {
      stage: "error",
      queue: null,
      error: "找不到这张图纸，可能已过期，请重新上传。",
    });
    return;
  }

  const out = runDir(runId);
  fs.mkdirSync(out, { recursive: true });

  updateRun(runId, {
    stage: "locating",
    queue: null,
    error: null,
    boxes: [],
    dimensions: [],
    failed: [],
    progress: { done: 0, total: 0 },
  });

  const config = JSON.stringify({
    scope: run.config.scope,
    density: run.config.density,
    exclude_title_block: run.config.excludeTitleBlock,
    max_boxes: 40,
  });

  const result = await runStageCli(
    [
      "locate",
      "--image",
      resolved.imagePath,
      "--out",
      out,
      "--channel",
      String(run.channel),
      "--config",
      config,
    ],
    LOCATE_TIMEOUT_MS
  );

  if (result.code !== 0) {
    updateRun(runId, {
      stage: "error",
      queue: null,
      error: friendlyError(result.stderr, result.code),
    });
    return;
  }

  const data = readJson<{
    image_width: number;
    image_height: number;
    boxes: RunBox[];
    channel_used: number;
    elapsed_ms: number;
  }>(path.join(out, "locate.json"));

  if (!data) {
    updateRun(runId, {
      stage: "error",
      queue: null,
      error: "定位结果读取失败，请重试。",
    });
    return;
  }

  updateRun(runId, {
    stage: "located",
    queue: null,
    error: null,
    boxes: data.boxes ?? [],
    imageWidth: data.image_width,
    imageHeight: data.image_height,
    locateMs: data.elapsed_ms ?? null,
    channelUsed: data.channel_used ?? run.channel,
    progress: { done: 0, total: (data.boxes ?? []).length },
  });
}

// --------------------------------------------------------------------------- //
// Export — render the annotated PNG from the stored result
// --------------------------------------------------------------------------- //

/**
 * Re-render <runDir>/annotated.png from the run's current dimensions.
 *
 * Downloads call this every time instead of trusting a file that may be
 * missing or stale: a missing file used to fall back to the clean original,
 * which looked like "the download button gives me the drawing back".
 */
export async function exportAnnotated(runId: string): Promise<boolean> {
  const run = getRun(runId);
  if (!run || run.dimensions.length === 0) return false;

  const resolved = resolveImagePath(run.filename);
  if (!resolved) return false;

  const out = runDir(runId);
  const result = await runStageCli(
    [
      "export",
      "--image",
      resolved.imagePath,
      "--out",
      out,
      "--run-json",
      path.join(out, "run.json"),
    ],
    60_000
  );
  return result.code === 0 && fs.existsSync(path.join(out, "annotated.png"));
}

// --------------------------------------------------------------------------- //
// Stage 2 — read
// --------------------------------------------------------------------------- //

export async function readJob(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  const resolved = resolveImagePath(run.filename);
  if (!resolved) {
    updateRun(runId, {
      stage: "error",
      queue: null,
      error: "找不到这张图纸，可能已过期，请重新上传。",
    });
    return;
  }
  if (run.boxes.length === 0) {
    updateRun(runId, {
      stage: "error",
      queue: null,
      error: "还没有可识别的框，请先完成标注定位。",
    });
    return;
  }

  const out = runDir(runId);
  fs.mkdirSync(out, { recursive: true });
  const boxesFile = path.join(out, "boxes.json");
  fs.writeFileSync(boxesFile, JSON.stringify(run.boxes), "utf-8");
  try {
    fs.rmSync(path.join(out, "progress.json"), { force: true });
  } catch {
    // ignore
  }

  updateRun(runId, {
    stage: "reading",
    queue: null,
    error: null,
    dimensions: [],
    failed: [],
    progress: { done: 0, total: run.boxes.length },
  });

  let lastDone = -1;
  const onTick = () => {
    const progress = readJson<{
      done: number;
      total: number;
      dimensions: RunState["dimensions"];
      failed: string[];
    }>(path.join(out, "progress.json"));
    if (!progress || progress.done === lastDone) return;
    lastDone = progress.done;
    updateRun(runId, {
      progress: { done: progress.done, total: progress.total },
      dimensions: progress.dimensions ?? [],
      failed: progress.failed ?? [],
    });
  };

  const result = await runStageCli(
    [
      "read",
      "--image",
      resolved.imagePath,
      "--out",
      out,
      "--channel",
      String(run.channel),
      "--boxes-file",
      boxesFile,
    ],
    READ_TIMEOUT_MS,
    onTick
  );

  if (result.code !== 0) {
    // Keep whatever was already read: a partial result is still useful and
    // the table shows which boxes were not read.
    const progress = readJson<{ dimensions: RunState["dimensions"]; failed: string[] }>(
      path.join(out, "progress.json")
    );
    updateRun(runId, {
      stage: "error",
      queue: null,
      error: friendlyError(result.stderr, result.code),
      dimensions: progress?.dimensions ?? getRun(runId)?.dimensions ?? [],
      failed: progress?.failed ?? getRun(runId)?.failed ?? [],
    });
    return;
  }

  const data = readJson<{
    dimensions: RunState["dimensions"];
    failed: string[];
    elapsed_ms: number;
    channel_used: number;
  }>(path.join(out, "read.json"));

  updateRun(runId, {
    stage: "done",
    queue: null,
    error: null,
    dimensions: data?.dimensions ?? [],
    failed: data?.failed ?? [],
    readMs: data?.elapsed_ms ?? null,
    channelUsed: data?.channel_used ?? getRun(runId)?.channelUsed ?? null,
    progress: {
      done: data?.dimensions?.length ?? 0,
      total: getRun(runId)?.boxes.length ?? 0,
    },
  });
}
