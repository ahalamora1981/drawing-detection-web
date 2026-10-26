// Server-side PIN session cookie.
//
// The PIN itself never leaves the server. Verifying it issues an HttpOnly
// cookie holding an HMAC of a per-process secret; cost-incurring API routes
// require that cookie. This matters because the demo is publicly reachable
// and every run spends real LLM credits — a client-side-only gate would stop
// nobody from POSTing to /api/runs directly.
//
// The secret lives in memory, so a server restart invalidates outstanding
// cookies and visitors simply re-enter the PIN.

import crypto from "crypto";

export const PIN_COOKIE = "dd_pin";
const COOKIE_MAX_AGE = 12 * 60 * 60; // 12 hours

const GLOBAL_KEY = "__drawingPinSecret__";

function secret(): Buffer {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = crypto.randomBytes(32);
  }
  return g[GLOBAL_KEY] as Buffer;
}

export function issueToken(): string {
  return crypto
    .createHmac("sha256", secret())
    .update("drawing-detection-pin-v1")
    .digest("hex");
}

export function verifyToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const expected = issueToken();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const PIN_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: true,
  path: "/",
  maxAge: COOKIE_MAX_AGE,
};
