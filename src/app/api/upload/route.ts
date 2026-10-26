import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { withBasePath } from "@/lib/basePath";
import { deleteRunsForFile } from "@/lib/runStore";
import { requirePin } from "@/lib/pinGuard";
import {
  addUpload,
  UploadLimitError,
  getMaxUploads,
  removeUpload,
} from "@/lib/uploadStore";
import {
  MAX_UPLOAD_BYTES,
  sniffImageKind,
  deriveDisplayName,
} from "@/lib/uploadUtils";

const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg"];

export async function POST(request: NextRequest) {
  const denied = requirePin(request);
  if (denied) return denied;

  try {
    const form = await request.formData();
    const file = form.get("file");
    const session = (form.get("session") as string | null) ?? "";

    if (!file || typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }
    if (!session) {
      return NextResponse.json({ error: "Missing session" }, { status: 400 });
    }

    const originalName = (file as { name: string }).name;
    const ext = path.extname(originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return NextResponse.json(
        { error: "Only PNG and JPG images are allowed." },
        { status: 400 }
      );
    }

    const size = (file as { size: number }).size;
    if (size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "Image must be 10 MB or smaller." },
        { status: 413 }
      );
    }

    const buffer = Buffer.from(await (file as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());

    // Validate content by magic bytes, not just extension.
    const kind = sniffImageKind(buffer);
    const isPng = ext === ".png";
    if ((isPng && kind !== "png") || (!isPng && kind !== "jpeg")) {
      return NextResponse.json(
        { error: "File content does not match its extension (PNG/JPG expected)." },
        { status: 400 }
      );
    }

    try {
      const meta = addUpload(session, { buffer, originalName });
      return NextResponse.json({
        image: {
          filename: meta.storageName,
          originalName: meta.originalName,
          displayName: deriveDisplayName(meta.originalName),
          thumbnailUrl: withBasePath(
            `/api/image?name=${encodeURIComponent(meta.storageName)}`
          ),
          fullUrl: withBasePath(
            `/api/image?name=${encodeURIComponent(meta.storageName)}`
          ),
          run: null,
          source: "upload",
        },
      });
    } catch (err) {
      if (err instanceof UploadLimitError) {
        return NextResponse.json(
          {
            error: `Maximum ${getMaxUploads()} uploads per session. Refresh the page to upload more.`,
          },
          { status: 429 }
        );
      }
      throw err;
    }
  } catch (error) {
    console.error("Upload API error:", error);
    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 }
    );
  }
}

/** Delete one of this session's uploads (file + metadata + its runs). */
export async function DELETE(request: NextRequest) {
  const denied = requirePin(request);
  if (denied) return denied;

  const name = request.nextUrl.searchParams.get("name") ?? "";
  const session = request.nextUrl.searchParams.get("session") ?? "";
  if (!name || !session) {
    return NextResponse.json({ error: "Missing name or session" }, { status: 400 });
  }
  const safeName = path.basename(name);
  if (safeName !== name || name.includes("..")) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }
  const removed = removeUpload(session, safeName);
  if (!removed) {
    return NextResponse.json({ error: "Upload not found" }, { status: 404 });
  }
  deleteRunsForFile(safeName);
  return NextResponse.json({ ok: true });
}
