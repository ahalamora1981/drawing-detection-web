import { cookies } from "next/headers";
import { LANG_COOKIE, normalizeLang, type Lang } from "./lang";

/** Language chosen on the last visit, read from the cookie on the server. */
export async function readLang(): Promise<Lang> {
  const store = await cookies();
  return normalizeLang(store.get(LANG_COOKIE)?.value);
}
