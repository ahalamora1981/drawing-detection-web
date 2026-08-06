import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// All paths are local to the web app — no outside dependencies.
const WEB_ROOT = process.cwd();
const TESTS_DIR = path.join(WEB_ROOT, "images", "tests");

export async function GET() {
  try {
    // List all test images
    const files = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith(".png"));
    const images = files.map((filename) => {
      return {
        filename,
        displayName: filename.replace(/\.png$/, "").replace(/-/g, " ").toUpperCase(),
        thumbnailUrl: `/api/image?name=${encodeURIComponent(filename)}`,
        fullUrl: `/api/image?name=${encodeURIComponent(filename)}`,
        // Clean start: no results and no annotated image until the user
        // runs detection. Boxes and detections only appear after
        // "Run Detection" completes.
        result: null,
        annotatedUrl: null,
      };
    });

    return NextResponse.json({ images });
  } catch (error) {
    console.error("Failed to list images:", error);
    return NextResponse.json(
      { error: "Failed to list images" },
      { status: 500 }
    );
  }
}
