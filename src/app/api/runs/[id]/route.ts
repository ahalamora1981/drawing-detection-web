import { NextRequest, NextResponse } from "next/server";
import { getRun, setBoxes } from "@/lib/runStore";
import { positionOf } from "@/lib/runQueue";
import { requirePin } from "@/lib/pinGuard";
import type { RunBox } from "@/lib/types";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const run = getRun(id);
  if (!run) {
    return NextResponse.json(
      { error: "Run not found", code: "run_not_found" },
      { status: 404 }
    );
  }

  // While a job is waiting in the queue, report its live position.
  let queue = run.queue;
  if (queue) {
    const position = positionOf(id);
    queue = position === null ? queue : { ...queue, position };
  }

  return NextResponse.json({ run: { ...run, queue } });
}

/** Replace the user-confirmed boxes (delete / add / adjust). */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const denied = requirePin(request);
  if (denied) return denied;

  const { id } = await context.params;
  const run = getRun(id);
  if (!run) {
    return NextResponse.json(
      { error: "Run not found", code: "run_not_found" },
      { status: 404 }
    );
  }
  if (run.stage === "locating" || run.stage === "reading" || run.stage === "queued") {
    return NextResponse.json(
      { error: "任务正在执行，请等待完成后再修改。", code: "busy" },
      { status: 409 }
    );
  }

  let body: { boxes?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "invalid_request" },
      { status: 400 }
    );
  }
  if (!Array.isArray(body.boxes)) {
    return NextResponse.json(
      { error: "Missing boxes array", code: "invalid_request" },
      { status: 400 }
    );
  }

  const width = run.imageWidth || 100000;
  const height = run.imageHeight || 100000;
  const boxes: RunBox[] = [];

  for (const raw of body.boxes.slice(0, 80)) {
    const b = raw as Partial<RunBox>;
    const x = Number(b.x);
    const y = Number(b.y);
    const w = Number(b.w);
    const h = Number(b.h);
    if (![x, y, w, h].every((n) => Number.isFinite(n))) continue;
    if (w < 4 || h < 4) continue;
    const x1 = Math.max(0, Math.min(x, width));
    const y1 = Math.max(0, Math.min(y, height));
    const x2 = Math.max(0, Math.min(x + w, width));
    const y2 = Math.max(0, Math.min(y + h, height));
    if (x2 - x1 < 4 || y2 - y1 < 4) continue;
    boxes.push({
      id: "",
      x: Math.round(x1 * 10) / 10,
      y: Math.round(y1 * 10) / 10,
      w: Math.round((x2 - x1) * 10) / 10,
      h: Math.round((y2 - y1) * 10) / 10,
    });
  }

  // Renumber so IDs stay stable and match the table after any edit.
  boxes.sort((a, b) => Math.round(a.y / 12) - Math.round(b.y / 12) || a.x - b.x);
  boxes.forEach((b, i) => {
    b.id = `box_${String(i + 1).padStart(3, "0")}`;
  });

  const updated = setBoxes(id, boxes);
  return NextResponse.json({ run: updated });
}
