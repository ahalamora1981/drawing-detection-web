import { NextRequest, NextResponse } from "next/server";
import { canAccept, maxWaiting, submit } from "@/lib/runQueue";
import { getRun, updateRun } from "@/lib/runStore";
import { readJob } from "@/lib/detectJob";
import { requirePin } from "@/lib/pinGuard";

const BUSY_MESSAGE = `当前排队已满（最多 ${maxWaiting()} 个等待），请稍后再试。`;

/** Start stage 2 on the boxes the user confirmed in stage 1. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const denied = requirePin(request);
  if (denied) return denied;

  const { id } = await context.params;
  const run = getRun(id);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (run.stage === "locating" || run.stage === "reading" || run.stage === "queued") {
    return NextResponse.json(
      { error: "任务正在执行，请稍候。" },
      { status: 409 }
    );
  }
  if (run.boxes.length === 0) {
    return NextResponse.json(
      { error: "还没有可识别的框，请先完成标注定位。" },
      { status: 400 }
    );
  }
  if (!canAccept()) {
    return NextResponse.json({ error: BUSY_MESSAGE }, { status: 429 });
  }

  const submitted = submit(id, () => readJob(id));
  const position = submitted.accepted ? submitted.position : 0;
  const updated = updateRun(id, {
    // Position 0 means the job starts now: flip the stage here so the
    // browser begins polling immediately (the job would otherwise set it a
    // few hundred ms later and the UI would never notice).
    stage: position === 0 ? "reading" : run.stage,
    queue: position > 0 ? { position, step: "read" } : null,
    error: null,
  });

  return NextResponse.json({ run: updated ?? run });
}
