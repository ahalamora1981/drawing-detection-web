// Base path helper — matches next.config.ts basePath.
// NEXT_PUBLIC_BASE_PATH is inlined into client bundles at build time
// and read from the environment on the server at runtime.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function withBasePath(url: string): string {
  if (!BASE_PATH) return url;
  return `${BASE_PATH}${url.startsWith("/") ? url : `/${url}`}`;
}
