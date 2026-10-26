// Server-side in-memory registry for user-uploaded drawings.
//
// Uploaded files are written to <web>/uploads/ on disk (so the Python
// detection engine can read them by path), while metadata lives in a Map
// keyed by a client-generated session id.
//
// The registry MUST live on globalThis, not as a plain module-level Map.
// In Next.js dev mode every route handler is compiled into its own module
// graph, so a module-level `const store = new Map()` is instantiated once
// PER ROUTE: addUpload() in upload/route.ts and findUpload()/getUploads()
// in detect/route.ts and images/route.ts would each mutate a different
// (empty) registry, and running detection on a just-uploaded image would
// always 404 with "Image not found". globalThis-backed state is shared
// across every route bundle in both dev and production.
//
// Lifecycle:
//   - Session-scoped: the client generates a fresh random session id in JS
//     memory on every page load, so a page refresh naturally orphans the old
//     uploads (they no longer appear in /api/images for the new session).
//   - TTL: files + metadata older than UPLOAD_TTL_MS (default 1 hour) are
//     purged on each list/upload operation, and by a periodic sweep timer.
//   - Max: MAX_UPLOADS_PER_SESSION (5) uploads per session.

import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface UploadMeta {
  storageName: string;
  originalName: string;
  createdAt: number;
}

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
// 24h: long enough that a visitor can come back to their uploads during a
// demo day. Runs use the same horizon so links never dangle.
const TTL_MS = Number(process.env.UPLOAD_TTL_MS ?? 24 * 60 * 60 * 1000);
const MAX_UPLOADS_PER_SESSION = 5;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const GLOBAL_STORE_KEY = "__uploadStoreRegistry__";

/** Shared registry instance (see comment above for why globalThis). */
function getStore(): Map<string, UploadMeta[]> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_STORE_KEY]) {
    g[GLOBAL_STORE_KEY] = new Map<string, UploadMeta[]>();
  }
  return g[GLOBAL_STORE_KEY] as Map<string, UploadMeta[]>;
}

const store = getStore();

export class UploadLimitError extends Error {
  constructor() {
    super("Maximum 5 uploads per session. Refresh the page to upload more.");
    this.name = "UploadLimitError";
  }
}

function ensureDir() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/** Delete on-disk upload files older than the TTL (survives server restarts). */
function sweepDir(now: number) {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return;
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const p = path.join(UPLOADS_DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p);
      } catch {
        // file vanished mid-sweep; ignore
      }
    }
  } catch {
    // dir missing or unreadable; nothing to do
  }
}

/** Remove expired entries from the in-memory registry and from disk. */
export function sweepExpired(now: number = Date.now()) {
  sweepDir(now);
  for (const [session, metas] of store) {
    const alive = metas.filter((m) => now - m.createdAt < TTL_MS);
    if (alive.length === metas.length) continue;
    store.set(session, alive);
    for (const dead of metas) {
      if (!alive.includes(dead)) {
        try {
          fs.unlinkSync(path.join(UPLOADS_DIR, dead.storageName));
        } catch {
          // already gone
        }
      }
    }
  }
}

function ensureSweepTimer() {
  const g = globalThis as unknown as { __uploadSweepTimer?: boolean };
  if (g.__uploadSweepTimer) return;
  g.__uploadSweepTimer = true;
  setInterval(() => sweepExpired(), SWEEP_INTERVAL_MS).unref?.();
}

function sanitizeStem(stem: string): string {
  const cleaned = stem
    .replace(/[^\w\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "upload";
}

/** Register an uploaded image and write it to disk. Returns its metadata. */
export function addUpload(
  session: string,
  file: { buffer: Buffer; originalName: string }
): UploadMeta {
  sweepExpired();
  ensureSweepTimer();

  const list = store.get(session) ?? [];
  if (list.length >= MAX_UPLOADS_PER_SESSION) {
    throw new UploadLimitError();
  }

  const safeStem = sanitizeStem(path.parse(file.originalName).name);
  const ext = path.extname(file.originalName).toLowerCase(); // .png / .jpg / .jpeg
  const storageName = `${Date.now()}-${crypto
    .randomBytes(4)
    .toString("hex")}-${safeStem}${ext}`;

  ensureDir();
  fs.writeFileSync(path.join(UPLOADS_DIR, storageName), file.buffer);

  const meta: UploadMeta = {
    storageName,
    originalName: file.originalName,
    createdAt: Date.now(),
  };
  list.push(meta);
  store.set(session, list);
  return meta;
}

/** List uploads for a session (live, after TTL sweep). */
export function getUploads(session: string): UploadMeta[] {
  sweepExpired();
  return store.get(session) ?? [];
}

/**
 * Find an upload by storage name across all sessions. Session-agnostic on
 * purpose: uploaded drawings are shared (everyone can see/run them).
 */
export function findUpload(storageName: string): UploadMeta | null {
  sweepExpired();
  for (const metas of store.values()) {
    const meta = metas.find((m) => m.storageName === storageName);
    if (meta) return meta;
  }
  return null;
}

export function getUploadsDir(): string {
  return UPLOADS_DIR;
}

/** Remove one upload of a session (file + metadata). */
export function removeUpload(session: string, storageName: string): boolean {
  const list = store.get(session) ?? [];
  const idx = list.findIndex((m) => m.storageName === storageName);
  if (idx === -1) return false;
  list.splice(idx, 1);
  store.set(session, list);
  try {
    fs.unlinkSync(path.join(UPLOADS_DIR, storageName));
  } catch {
    // already gone
  }
  return true;
}

export function getMaxUploads(): number {
  return MAX_UPLOADS_PER_SESSION;
}
