import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// All paths are local to the web app — no outside dependencies.
const WEB_ROOT = process.cwd();
const TESTS_DIR = path.join(WEB_ROOT, "images", "tests");

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name");

  if (!name) {
    return NextResponse.json({ error: "Missing 'name' parameter" }, { status: 400 });
  }

  // Sanitize: only allow simple filenames
  const safeName = path.basename(name);
  if (safeName !== name || name.includes("..")) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const filePath = path.join(TESTS_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
