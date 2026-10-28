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
      return NextResponse.json(
        { error: "Missing file", code: "invalid_request" },
        { status: 400 }
      );
    }
    if (!session) {
      return NextResponse.json(
        { error: "Missing session", code: "invalid_request" },
        { status: 400 }
      );
    }

    const originalName = (file as { name: string }).name;
    const ext = path.extname(originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return NextResponse.json(
        { error: "Only PNG and JPG images are allowed.", code: "upload_type" },
        { status: 400 }
      );
    }

    const size = (file as { size: number }).size;
    if (size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "Image must be 10 MB or smaller.", code: "upload_size" },
        { status: 413 }
      );
    }

    const buffer = Buffer.from(await (file as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());

    // Validate content by magic bytes, not just extension.
    const kind = sniffImageKind(buffer);
    const isPng = ext === ".png";
    if ((isPng && kind !== "png") || (!isPng && kind !== "jpeg")) {
      return NextResponse.json(
        { error: "File content does not match its extension (PNG/JPG expected).", code: "upload_type" },
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
            code: "upload_limit",
          },
          { status: 429 }
        );
      }
      throw err;
    }
  } catch (error) {
    console.error("Upload API error:", error);
    return NextResponse.json(
      { error: "Upload failed", code: "upload_failed" },
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
    return NextResponse.json(
      { error: "Missing name or session", code: "invalid_request" },
      { status: 400 }
    );
  }
  const safeName = path.basename(name);
  if (safeName !== name || name.includes("..")) {
    return NextResponse.json(
      { error: "Invalid filename", code: "invalid_request" },
      { status: 400 }
    );
  }
  const removed = removeUpload(session, safeName);
  if (!removed) {
    return NextResponse.json(
      { error: "Upload not found", code: "upload_not_found" },
      { status: 404 }
    );
  }
  deleteRunsForFile(safeName);
  return NextResponse.json({ ok: true });
}
