import { NextRequest, NextResponse } from "next/server";
import { getProjectVar } from "@/lib/env";
import { PIN_COOKIE, PIN_COOKIE_OPTIONS, issueToken } from "@/lib/pinAuth";

// Verifies the app-level PIN. The PIN lives ONLY server-side (APP_PIN in
// .env) and is never shipped to the client. The UI shows a PIN pop-up on
// every page refresh and verifies it here; success is held in memory for
// the current page session only, so a refresh re-arms the gate.

/** Lets the client know whether a PIN is required at all. */
export async function GET() {
  const expected = getProjectVar("APP_PIN");
  return NextResponse.json(
    { required: !!expected },
    { headers: { "Cache-Control": "no-store" } }
  );
}

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
      { ok: false, error: "应用 PIN 未配置（APP_PIN 缺失）。", code: "pin_config" },
      { status: 503 }
    );
  }
  if (pin === expected) {
    const res = NextResponse.json({ ok: true });
    // HttpOnly proof of the PIN: cost-incurring API routes require it.
    res.cookies.set(PIN_COOKIE, issueToken(), PIN_COOKIE_OPTIONS);
    return res;
  }
  return NextResponse.json(
    { ok: false, error: "PIN 错误。", code: "pin_wrong" },
    { status: 401 }
  );
}
