import { NextRequest, NextResponse } from "next/server";
import { getProjectVar } from "./env";
import { PIN_COOKIE, verifyToken } from "./pinAuth";

/**
 * Gate for routes that cost money or disk. Returns a 401 response when the
 * caller has not passed the PIN gate, or null when the request may proceed.
 * If the deployment has no APP_PIN configured, the gate is open (matching
 * the UI, which then skips the PIN dialog).
 */
export function requirePin(request: NextRequest): NextResponse | null {
  if (!getProjectVar("APP_PIN")) return null;
  if (verifyToken(request.cookies.get(PIN_COOKIE)?.value)) return null;
  return NextResponse.json(
    { error: "PIN 未验证，请刷新页面重新输入 PIN。" },
    { status: 401 }
  );
}
