"use client";

// A tiny client-side signal: "the server says we are not PIN-verified".
//
// The PIN cookie is tied to a per-process secret, so a server restart (or a
// 12-hour expiry) invalidates it while the page is still open. Rather than
// leaving the user with a bare 401 message, any 401 re-arms the PIN dialog.

type Listener = () => void;

const GLOBAL_KEY = "__drawingPinSignal__";

function listeners(): Set<Listener> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Set<Listener>();
  return g[GLOBAL_KEY] as Set<Listener>;
}

export function onPinRequired(listener: Listener): () => void {
  const set = listeners();
  set.add(listener);
  return () => set.delete(listener);
}

export function requirePinAgain(): void {
  for (const listener of listeners()) listener();
}
