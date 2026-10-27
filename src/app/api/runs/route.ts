import { NextRequest, NextResponse } from "next/server";
import { canAccept, maxWaiting, submit } from "@/lib/runQueue";
import { createRun, getRun, invalidateAnnotated, updateRun } from "@/lib/runStore";
import { locateJob, resolveImagePath } from "@/lib/detectJob";
import { deriveDisplayName } from "@/lib/uploadUtils";
import { findUpload } from "@/lib/uploadStore";
import { requirePin } from "@/lib/pinGuard";
import { consumeRun, maxRunsPerSession } from "@/lib/quota";
import type { RunConfig } from "@/lib/types";

function normalizeConfig(raw: unknown): RunConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const scope = cfg.scope === "all_text" ? "all_text" : "dimensions";
  const density =
    cfg.density === "conservative" || cfg.density === "aggressive"
      ? cfg.density
      : "standard";
  return {
    scope,
    density,
    excludeTitleBlock: cfg.excludeTitleBlock === true,
  };
}

const BUSY_MESSAGE = `当前排队已满（最多 ${maxWaiting()} 个等待），请稍后再试。`;

export async function POST(request: NextRequest) {
  const denied = requirePin(request);
  if (denied) return denied;

  let body: {
    session?: string;
    filename?: string;
    config?: unknown;
    channel?: number;
    runId?: string;
  } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const session = (body.session ?? "").trim();
  const filename = (body.filename ?? "").trim();
  if (!session) return NextResponse.json({ error: "Missing session" }, { status: 400 });
  if (!filename) return NextResponse.json({ error: "Missing filename" }, { status: 400 });

  const resolved = resolveImagePath(filename);
  if (!resolved) {
    return NextResponse.json(
      { error: "找不到这张图纸，可能已过期，请重新上传。" },
      { status: 404 }
    );
  }

  // Re-running the locate stage on an existing run keeps the same URL, so a
  // refresh still lands on the right run.
  let run = body.runId ? getRun(body.runId) : null;
  if (run && run.session !== session) run = null;

  const config = normalizeConfig(body.config);
  const channel = body.channel === 1 ? 1 : 2;

  // Uploaded files are stored under a timestamped name; the readable name
  // comes from the original filename.
  const upload = findUpload(filename);
  const originalName = upload?.originalName ?? filename;

  if (!run) {
    if (!consumeRun(session)) {
      return NextResponse.json(
        {
          error: `本次会话已达到 ${maxRunsPerSession()} 次检测上限，刷新页面可重新开始。`,
        },
        { status: 429 }
      );
    }
    run = createRun({
      session,
      filename,
      originalName,
      displayName: deriveDisplayName(originalName),
      source: resolved.source,
      config,
      channel,
    });
  } else {
    invalidateAnnotated(run.id);
    updateRun(run.id, {
      config,
      channel,
      boxes: [],
      dimensions: [],
      failed: [],
      progress: { done: 0, total: 0 },
      locateMs: null,
      readMs: null,
      error: null,
      stage: "queued",
      queue: null,
    });
  }

  if (!canAccept()) {
    updateRun(run.id, { stage: "error", queue: null, error: BUSY_MESSAGE });
    return NextResponse.json({ error: BUSY_MESSAGE, runId: run.id }, { status: 429 });
  }

  const runId = run.id;
  const submitted = submit(runId, () => locateJob(runId));
  const position = submitted.accepted ? submitted.position : 0;
  const updated = updateRun(runId, {
    stage: "queued",
    queue: position > 0 ? { position, step: "locate" } : null,
    error: null,
  });

  return NextResponse.json({ run: updated ?? run });
}
