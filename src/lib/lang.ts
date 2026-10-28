// Shared language constants (safe to import from both server and client).

export type Lang = "zh" | "en";

export const LANG_COOKIE = "dd_lang";

/** English is the default; the cookie only needs to remember "zh". */
export function normalizeLang(value: string | undefined | null): Lang {
  return value === "zh" ? "zh" : "en";
}
