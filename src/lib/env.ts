import fs from "fs";
import path from "path";

// All paths are local to the web app — no outside dependencies.
const WEB_ROOT = process.cwd();
export const ENV_FILE = path.join(WEB_ROOT, ".env");

/**
 * Parse a simple KEY=VALUE .env file (comments and blank lines skipped).
 * Values are NOT shell-unquoted — the project's .env files use plain values.
 */
export function loadEnvFile(envPath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      vars[key] = value;
    }
  } catch {
    // .env not found, that's okay
  }
  return vars;
}

// Loaded once at server start (Next.js also injects .env into process.env;
// this file-level copy is a fallback for values added after boot).
const projectEnv = loadEnvFile(ENV_FILE);

/**
 * Look up a project variable: runtime process.env wins (set by Next from
 * .env at boot), then the parsed .env file as a fallback.
 */
export function getProjectVar(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  return projectEnv[name];
}

export { projectEnv };
