import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { withBasePath } from "@/lib/basePath";
import { getUploads } from "@/lib/uploadStore";
import { deriveDisplayName } from "@/lib/uploadUtils";
import type { TestImage } from "@/lib/types";

// All paths are local to the web app — no outside dependencies.
const WEB_ROOT = process.cwd();
const TESTS_DIR = path.join(WEB_ROOT, "images", "tests");

export async function GET(request: NextRequest) {
  try {
    // List all test images
    const files = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith(".png"));
    const images: TestImage[] = files.map((filename) => {
      return {
        filename,
        displayName: deriveDisplayName(filename),
        thumbnailUrl: withBasePath(`/api/image?name=${encodeURIComponent(filename)}`),
        fullUrl: withBasePath(`/api/image?name=${encodeURIComponent(filename)}`),
        // Clean start: no results and no annotated image until the user
        // runs detection. Boxes and detections only appear after
        // "Run Detection" completes.
        result: null,
        annotatedUrl: null,
        source: "test" as const,
      };
    });

    // Append this session's uploads underneath the test images.
    const session = request.nextUrl.searchParams.get("session") ?? "";
    if (session) {
      for (const meta of getUploads(session)) {
        images.push({
          filename: meta.storageName,
          displayName: deriveDisplayName(meta.originalName),
          thumbnailUrl: withBasePath(
            `/api/image?name=${encodeURIComponent(meta.storageName)}`
          ),
          fullUrl: withBasePath(
            `/api/image?name=${encodeURIComponent(meta.storageName)}`
          ),
          result: null,
          annotatedUrl: null,
          source: "upload" as const,
        });
      }
    }

    return NextResponse.json({ images });
  } catch (error) {
    console.error("Failed to list images:", error);
    return NextResponse.json(
      { error: "Failed to list images" },
      { status: 500 }
    );
  }
}
