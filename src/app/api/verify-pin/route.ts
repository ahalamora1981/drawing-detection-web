import { NextRequest, NextResponse } from "next/server";
import { getProjectVar } from "@/lib/env";

// Verifies the app-level PIN. The PIN lives ONLY server-side (APP_PIN in
// .env) and is never shipped to the client. The UI shows a PIN pop-up on
// every page refresh and verifies it here; success is held in memory for
// the current page session only, so a refresh re-arms the gate.
export async function POST(request: NextRequest) {
  let body: { pin?: string } = {};
  try {
    body = await request.json();
  } catch {
    // handled below as empty pin
  }

  const pin = (body?.pin ?? "").trim();
  const expected = getProjectVar("APP_PIN");

  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "应用 PIN 未配置（APP_PIN 缺失）。" },
      { status: 503 }
    );
  }
  if (pin === expected) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json(
    { ok: false, error: "PIN 错误。" },
    { status: 401 }
  );
}
