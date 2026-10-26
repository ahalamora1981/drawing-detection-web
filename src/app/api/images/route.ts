import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { withBasePath } from "@/lib/basePath";
import { getUploads } from "@/lib/uploadStore";
import { deriveDisplayName } from "@/lib/uploadUtils";
import { latestRun, summarize } from "@/lib/runStore";
import type { GalleryImage } from "@/lib/types";

// All paths are local to the web app — no outside dependencies.
const WEB_ROOT = process.cwd();
const TESTS_DIR = path.join(WEB_ROOT, "images", "tests");

/**
 * List every drawing available to this session, with the status of the most
 * recent run on each one so the gallery can show "已定位 12 处" etc.
 */
export async function GET(request: NextRequest) {
  try {
    const session = request.nextUrl.searchParams.get("session") ?? "";
    const files = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith(".png"));

    const images: GalleryImage[] = files.map((filename) => {
      const run = session ? latestRun(session, filename) : null;
      return {
        filename,
        displayName: deriveDisplayName(filename),
        thumbnailUrl: withBasePath(`/api/image?name=${encodeURIComponent(filename)}`),
        fullUrl: withBasePath(`/api/image?name=${encodeURIComponent(filename)}`),
        source: "test" as const,
        run: run ? summarize(run) : null,
      };
    });

    // This session's uploads come first: they are what the user just did.
    if (session) {
      const uploads: GalleryImage[] = getUploads(session).map((meta) => {
        const run = latestRun(session, meta.storageName);
        return {
          filename: meta.storageName,
          originalName: meta.originalName,
          displayName: deriveDisplayName(meta.originalName),
          thumbnailUrl: withBasePath(
            `/api/image?name=${encodeURIComponent(meta.storageName)}`
          ),
          fullUrl: withBasePath(
            `/api/image?name=${encodeURIComponent(meta.storageName)}`
          ),
          source: "upload" as const,
          run: run ? summarize(run) : null,
        };
      });
      return NextResponse.json({ images, uploads });
    }

    return NextResponse.json({ images, uploads: [] });
  } catch (error) {
    console.error("Failed to list images:", error);
    return NextResponse.json({ error: "Failed to list images" }, { status: 500 });
  }
}
