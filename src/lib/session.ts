"use client";

// Session id shared by the gallery and the workbench.
//
// It lives in sessionStorage, not memory, because the two pages are separate
// documents: an in-memory id would be regenerated on every navigation and the
// user's uploads would disappear the moment they open a drawing. Closing the
// tab still clears it, which is the behaviour we want for a shared demo.

const KEY = "drawing-detection-session";

export function getSessionId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.sessionStorage.getItem(KEY);
    if (existing) return existing;
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    // Private mode / storage disabled: fall back to a per-load id.
    return `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
