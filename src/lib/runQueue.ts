// Tiny serial job queue with a bounded waiting list.
//
// Why: every detection run calls a metered Vision LLM. Letting N browser tabs
// run at once multiplies the call rate and trips gateway quotas (the classic
// "first image works, the rest time out"). Previously the API simply rejected
// concurrent requests, which looks broken in a live demo. Now the second and
// third visitor wait in line and the UI says where they are.

const MAX_WAITING = 2;

interface Job {
  id: string;
  run: () => Promise<void>;
}

interface QueueState {
  active: Job | null;
  waiting: Job[];
}

const GLOBAL_KEY = "__drawingRunQueue__";

function state(): QueueState {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { active: null, waiting: [] } as QueueState;
  }
  return g[GLOBAL_KEY] as QueueState;
}

function pump() {
  const q = state();
  if (q.active) return;
  const next = q.waiting.shift();
  if (!next) return;
  q.active = next;
  next
    .run()
    .catch((err) => console.error(`[queue] job ${next.id} failed:`, err))
    .finally(() => {
      q.active = null;
      pump();
    });
}

export type SubmitResult =
  | { accepted: true; position: number }
  | { accepted: false; reason: "busy" };

/**
 * Queue a job. Returns its 1-based queue position (0 = starts immediately).
 * Rejects when the waiting list is full so the UI can ask the user to retry.
 */
export function submit(id: string, job: () => Promise<void>): SubmitResult {
  const q = state();
  if (!q.active) {
    q.active = { id, run: job };
    Promise.resolve()
      .then(job)
      .catch((err) => console.error(`[queue] job ${id} failed:`, err))
      .finally(() => {
        q.active = null;
        pump();
      });
    return { accepted: true, position: 0 };
  }
  if (q.waiting.length >= MAX_WAITING) {
    return { accepted: false, reason: "busy" };
  }
  q.waiting.push({ id, run: job });
  return { accepted: true, position: q.waiting.length };
}

/** Current 1-based position of a queued job, or null if it is not waiting. */
export function positionOf(id: string): number | null {
  const q = state();
  const idx = q.waiting.findIndex((j) => j.id === id);
  return idx === -1 ? null : idx + 1;
}

export function maxWaiting(): number {
  return MAX_WAITING;
}

/** True when a new job can be accepted right now. */
export function canAccept(): boolean {
  const q = state();
  return !q.active || q.waiting.length < MAX_WAITING;
}
