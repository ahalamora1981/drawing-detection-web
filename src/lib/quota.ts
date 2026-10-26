// Per-session run quota.
//
// The PIN keeps strangers out; this keeps one visitor from burning the whole
// LLM budget in a loop. Counted per session (not per IP: a demo room shares
// one NAT address).

const GLOBAL_KEY = "__drawingRunQuota__";
const DEFAULT_MAX_RUNS = 20;

function store(): Map<string, number> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map<string, number>();
  return g[GLOBAL_KEY] as Map<string, number>;
}

export function maxRunsPerSession(): number {
  const raw = Number(process.env.MAX_RUNS_PER_SESSION ?? DEFAULT_MAX_RUNS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_RUNS;
}

/** Count one new run for this session. False when the quota is exhausted. */
export function consumeRun(session: string): boolean {
  const s = store();
  const used = s.get(session) ?? 0;
  if (used >= maxRunsPerSession()) return false;
  s.set(session, used + 1);
  return true;
}

export function runsUsed(session: string): number {
  return store().get(session) ?? 0;
}
