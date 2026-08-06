import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// All paths are local to the web app — no outside dependencies.
const WEB_ROOT = process.cwd();
const TESTS_DIR = path.join(WEB_ROOT, "images", "tests");
const ANNOTATED_DIR = path.join(WEB_ROOT, "output", "test_results");

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name");

  if (!name) {
    return NextResponse.json({ error: "Missing 'name' parameter" }, { status: 400 });
  }

  // Sanitize
  const safeName = path.basename(name);
  if (safeName !== name || name.includes("..")) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  // Look for annotated version: test-001.png → test-001_annotated.png
  const stem = safeName.replace(/\.png$/, "");
  const annotatedName = `${stem}_annotated.png`;
  const annotatedPath = path.join(ANNOTATED_DIR, annotatedName);

  if (fs.existsSync(annotatedPath)) {
    const buffer = fs.readFileSync(annotatedPath);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "image/png",
        // Annotated images change after each detection run; never cache
        "Cache-Control": "no-store",
      },
    });
  }

  // Fall back to original if no annotated version exists
  const originalPath = path.join(TESTS_DIR, safeName);
  if (fs.existsSync(originalPath)) {
    const buffer = fs.readFileSync(originalPath);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  return NextResponse.json({ error: "Image not found" }, { status: 404 });
}
