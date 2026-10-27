// Server-side registry for detection runs.
//
// A "run" is one drawing's two-stage detection session: the boxes located in
// stage 1, the user's edits to those boxes, and the values read in stage 2.
// Runs are persisted to <web>/output/runs/<runId>/ so that
//   - a page refresh can restore progress (the run id lives in the URL),
//   - two visitors never overwrite each other's artefacts,
//   - stage 2 can read the boxes the user confirmed in stage 1.
//
// Like the upload registry, the in-memory index MUST live on globalThis:
// Next.js dev mode compiles each route into its own module graph, so a
// module-level Map would give every route its own empty copy.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { RunBox, RunConfig, RunState, RunSummary } from "./types";

const WEB_ROOT = process.cwd();
const RUNS_DIR = path.join(WEB_ROOT, "output", "runs");
const RUN_TTL_MS = Number(process.env.RUN_TTL_MS ?? 24 * 60 * 60 * 1000); // 24h
const UPLOADS_DIR = path.join(WEB_ROOT, "uploads");

const GLOBAL_KEY = "__drawingRunRegistry__";

interface Registry {
  runs: Map<string, RunState>;
  loaded: boolean;
  sweeping: boolean;
}

function registry(): Registry {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { runs: new Map(), loaded: false, sweeping: false } as Registry;
  }
  return g[GLOBAL_KEY] as Registry;
}

export function runsDir(): string {
  return RUNS_DIR;
}

export function runDir(id: string): string {
  return path.join(RUNS_DIR, id);
}

export function runFilePath(id: string): string {
  return path.join(runDir(id), "run.json");
}

function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/** Load every run.json from disk once (survives server restarts). */
function ensureLoaded() {
  const reg = registry();
  if (reg.loaded) return;
  reg.loaded = true;
  try {
    if (!fs.existsSync(RUNS_DIR)) return;
    for (const id of fs.readdirSync(RUNS_DIR)) {
      const file = runFilePath(id);
      try {
        if (!fs.existsSync(file)) continue;
        const run = JSON.parse(fs.readFileSync(file, "utf-8")) as RunState;
        if (run?.id) reg.runs.set(run.id, run);
      } catch {
        // corrupt / half-written run: ignore
      }
    }
  } catch {
    // runs dir unreadable; start empty
  }
}

/** Delete run directories older than the TTL (public demo hygiene). */
export function sweepRuns(now: number = Date.now()) {
  const reg = registry();
  if (reg.sweeping) return;
  reg.sweeping = true;
  try {
    if (!fs.existsSync(RUNS_DIR)) return;
    for (const id of fs.readdirSync(RUNS_DIR)) {
      const dir = runDir(id);
      try {
        const stat = fs.statSync(dir);
        const run = reg.runs.get(id);
        // Drop expired runs, and runs whose uploaded drawing was purged.
        const orphaned =
          run?.source === "upload" &&
          !fs.existsSync(path.join(UPLOADS_DIR, run.filename));
        if (now - stat.mtimeMs > RUN_TTL_MS || orphaned) {
          fs.rmSync(dir, { recursive: true, force: true });
          reg.runs.delete(id);
        }
      } catch {
        // vanished mid-sweep
      }
    }
    for (const [id, run] of reg.runs) {
      if (now - run.updatedAt > RUN_TTL_MS) reg.runs.delete(id);
    }
  } finally {
    reg.sweeping = false;
  }
}

export interface CreateRunInput {
  session: string;
  filename: string;
  originalName: string | null;
  displayName: string;
  source: "test" | "upload";
  config: RunConfig;
  channel: number;
}

export function createRun(input: CreateRunInput): RunState {
  ensureLoaded();
  sweepRuns();
  const id = `run_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const now = Date.now();
  const run: RunState = {
    id,
    session: input.session,
    filename: input.filename,
    originalName: input.originalName,
    displayName: input.displayName,
    source: input.source,
    imageWidth: 0,
    imageHeight: 0,
    config: input.config,
    channel: input.channel,
    stage: "queued",
    queue: null,
    boxes: [],
    dimensions: [],
    progress: { done: 0, total: 0 },
    failed: [],
    locateMs: null,
    readMs: null,
    channelUsed: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  registry().runs.set(id, run);
  writeJsonAtomic(runFilePath(id), run);
  return run;
}

export function getRun(id: string): RunState | null {
  ensureLoaded();
  return registry().runs.get(id) ?? null;
}

/** Merge a patch into a run and persist it. Returns the updated run. */
export function updateRun(id: string, patch: Partial<RunState>): RunState | null {
  ensureLoaded();
  const run = registry().runs.get(id);
  if (!run) return null;
  const next: RunState = { ...run, ...patch, updatedAt: Date.now() };
  registry().runs.set(id, next);
  try {
    writeJsonAtomic(runFilePath(id), next);
  } catch (err) {
    console.error("Failed to persist run:", err);
  }
  return next;
}

/** Delete the cached annotated PNG so it can never describe older boxes. */
export function invalidateAnnotated(id: string) {
  try {
    fs.rmSync(path.join(runDir(id), "annotated.png"), { force: true });
  } catch {
    // nothing to remove
  }
}

export function setBoxes(id: string, boxes: RunBox[]): RunState | null {
  // Editing boxes invalidates any values read from the previous boxes, and
  // the exported image drawn for those boxes.
  invalidateAnnotated(id);
  return updateRun(id, {
    boxes,
    dimensions: [],
    failed: [],
    progress: { done: 0, total: 0 },
    stage: "located",
    error: null,
  });
}

/** All runs of one session, newest first. */
export function listRuns(session: string): RunState[] {
  ensureLoaded();
  sweepRuns();
  return [...registry().runs.values()]
    .filter((r) => r.session === session)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The most recent run for a given drawing in this session. */
export function latestRun(session: string, filename: string): RunState | null {
  return listRuns(session).find((r) => r.filename === filename) ?? null;
}

export function summarize(run: RunState): RunSummary {
  return {
    id: run.id,
    stage: run.stage,
    boxCount: run.boxes.length,
    detectedCount: run.dimensions.length,
    reviewCount: run.dimensions.filter((d) => d.needs_review).length,
  };
}

/** Remove every run created for a deleted upload. */
export function deleteRunsForFile(filename: string) {
  ensureLoaded();
  const reg = registry();
  for (const [id, run] of reg.runs) {
    if (run.filename !== filename) continue;
    try {
      fs.rmSync(runDir(id), { recursive: true, force: true });
    } catch {
      // ignore
    }
    reg.runs.delete(id);
  }
}
