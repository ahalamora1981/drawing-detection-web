// Shared helpers for validating and naming user uploads.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

export type UploadKind = "png" | "jpeg";

function hasMagic(buf: Buffer, magic: number[]): boolean {
  if (buf.length < magic.length) return false;
  return magic.every((byte, i) => buf[i] === byte);
}

export function sniffImageKind(buf: Buffer): UploadKind | null {
  if (hasMagic(buf, PNG_MAGIC)) return "png";
  if (hasMagic(buf, JPEG_MAGIC)) return "jpeg";
  return null;
}

/** Derive a human display name from a filename, matching test-image style. */
export function deriveDisplayName(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  return stem.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
}
