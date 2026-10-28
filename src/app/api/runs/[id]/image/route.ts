import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getRun, runDir } from "@/lib/runStore";
import { exportAnnotated, resolveImagePath } from "@/lib/detectJob";

/**
 * Serve a run's images.
 *   ?variant=annotated (default) — the exported PNG drawn by the engine,
 *                                  falling back to the clean original.
 *   ?variant=original            — the drawing as uploaded.
 *   &download=1                  — send as an attachment.
 */
export async function GET(
  request: NextRequest,
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

  const variant = request.nextUrl.searchParams.get("variant") ?? "annotated";
  const download = request.nextUrl.searchParams.get("download") === "1";

  const resolved = resolveImagePath(run.filename);
  if (!resolved) {
    return NextResponse.json(
      { error: "Image not found", code: "image_not_found" },
      { status: 404 }
    );
  }

  let file = resolved.imagePath;
  if (variant === "annotated") {
    // Always render from the run's current dimensions. A missing/stale file
    // used to be silently replaced by the clean original, which is
    // indistinguishable from "the button does nothing".
    if (run.dimensions.length === 0) {
      return NextResponse.json(
        { error: "还没有识别结果，无法导出标注图。", code: "no_results" },
        { status: 409 }
      );
    }
    const ok = await exportAnnotated(id);
    if (!ok) {
      return NextResponse.json(
        { error: "标注图生成失败，请重试。", code: "export_failed" },
        { status: 500 }
      );
    }
    file = path.join(runDir(id), "annotated.png");
  }

  const ext = path.extname(file).toLowerCase();
  const contentType =
    ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
  };
  if (download) {
    const stem = run.displayName.replace(/[^\w\-]+/g, "-").toLowerCase() || "drawing";
    headers["Content-Disposition"] = `attachment; filename="${stem}-annotated.png"`;
  }

  const buffer = fs.readFileSync(file);
  return new NextResponse(new Uint8Array(buffer), { headers });
}
