/**
 * The offline queue's rules, independent of the browser. Every action staff take while the hub may be unreachable is
 * saved as an entry first and sent from here, so nothing is lost on a dropped connection, a reload or a second window.
 *
 * - Lanes: entries for the same order go in order; different orders never wait on each other.
 * - Backoff: a lane that fails to reach the hub waits 1 s, 2 s, 4 s … up to 30 s (with jitter) before trying again.
 * - Chains: an entry can wait for an earlier one and use its result (issue a bill, then take payment on that bill).
 * - Results: every finished entry leaves a result record, so whoever queued it learns the outcome in any window.
 * - Review: a request the hub refuses (4xx) stops in "needs attention" with the reason; staff retry or discard it.
 * Exactly-once delivery relies on each request carrying a reference the hub uses to ignore repeats.
 */

export interface QueueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

export interface QueueEntry {
  id: string;
  userId: string;
  /** The database generation the action belongs to; a restored database never receives older actions. */
  generation: string;
  method: "POST" | "PATCH";
  /** May contain `{after:<path>}`, filled from the result of the entry this one waits for. */
  path: string;
  body: string;
  label: string;
  /** Entries in one lane go in order: an order id, so different orders never wait on each other. */
  lane: string;
  createdAt: number;
  /** The entry this one waits for, and whose result it may use. */
  after?: string;
  status: "pending" | "attention";
  attempts: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number;
  /** The last problem reaching the hub (pending) or why the hub refused it (attention), in plain words. */
  lastError?: string;
  /** For item punches: the cart draft whose rows this request carries, cleared row by row when the hub acknowledges it. */
  draftKey?: string;
  /** What the action was about, for the review list. */
  context?: { orderId?: string; table?: string };
}

export interface QueueResult {
  id: string;
  status: "done" | "rejected" | "discarded";
  value?: unknown;
  error?: string;
  at: number;
}

/** How a send failed: the hub was not reached (try again later) or it refused the request (needs review). */
export interface SendFailure { status?: number; message: string }

export const ENTRY_PREFIX = "forkflow.queue.v2.";
export const RESULT_PREFIX = "forkflow.queue-result.v2.";
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 30_000;

export function backoffMs(attempts: number, random: () => number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

/** Network failures, timeouts, server errors, rate limits and expired sign-ins are worth trying again; other refusals are not. */
export function isRetryable(failure: SendFailure): boolean {
  return failure.status === undefined || failure.status >= 500 || failure.status === 401 || failure.status === 429 || failure.status === 408;
}

const readJson = <T>(store: QueueStore, key: string): T | null => {
  const raw = store.get(key);
  if (raw === null) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
};

export function listEntries(store: QueueStore, userId?: string | null): QueueEntry[] {
  const entries: QueueEntry[] = [];
  for (const key of store.keys()) {
    if (!key.startsWith(ENTRY_PREFIX)) continue;
    const entry = readJson<QueueEntry>(store, key);
    if (entry && (userId === undefined || entry.userId === userId)) entries.push(entry);
  }
  return entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export const saveEntry = (store: QueueStore, entry: QueueEntry) => store.set(ENTRY_PREFIX + entry.id, JSON.stringify(entry));
export const readResult = (store: QueueStore, id: string) => readJson<QueueResult>(store, RESULT_PREFIX + id);

function finish(store: QueueStore, entry: QueueEntry, result: Omit<QueueResult, "id">): void {
  store.set(RESULT_PREFIX + entry.id, JSON.stringify({ id: entry.id, ...result }));
  store.remove(ENTRY_PREFIX + entry.id);
}

/** Entries waiting for `id` cannot go ahead once it was refused or discarded: they stop for review too. */
function stopDependents(store: QueueStore, id: string, reason: string): void {
  for (const entry of listEntries(store)) {
    if (entry.after !== id || entry.status === "attention") continue;
    saveEntry(store, { ...entry, status: "attention", lastError: reason });
    stopDependents(store, entry.id, reason);
  }
}

/** Fills `{after:bill.id}`-style placeholders from the result value of the entry waited for. */
export function resolvePath(path: string, afterValue: unknown): string {
  return path.replace(/\{after:([a-zA-Z0-9_.]+)\}/g, (_, dotted: string) => {
    let value: unknown = afterValue;
    for (const part of dotted.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`The earlier step's result has no ${dotted}`);
    return encodeURIComponent(String(value));
  });
}

/**
 * The entries that may be sent now: the first entry of each lane, unless it is stopped for review, still backing off, or
 * waiting for an earlier entry that has not finished yet.
 */
export function dueEntries(store: QueueStore, userId: string, now: number): QueueEntry[] {
  const due: QueueEntry[] = [];
  const seen = new Set<string>();
  for (const entry of listEntries(store, userId)) {
    if (seen.has(entry.lane)) continue;
    seen.add(entry.lane);
    if (entry.status === "attention" || entry.nextAttemptAt > now) continue;
    if (entry.after && !readResult(store, entry.after)) continue;
    due.push(entry);
  }
  return due;
}

export interface RunDeps {
  store: QueueStore;
  send(method: QueueEntry["method"], path: string, body: string): Promise<unknown>;
  now(): number;
  random(): number;
  /** Stops a run early, for example when the person signs out mid-run. */
  stillCurrent?(): boolean;
}

/**
 * Sends every entry that is due, one lane at a time. Returns how many were finished. A lane that cannot reach the hub
 * backs off on its own; the other lanes still go.
 */
export async function runDue(deps: RunDeps, userId: string, generation: string): Promise<number> {
  // Each lane's first entry goes at the same time, so a request that hangs until its timeout holds up only its own order.
  const done = await Promise.all(dueEntries(deps.store, userId, deps.now()).map((entry) => sendEntry(deps, entry.id, generation)));
  return done.filter(Boolean).length;
}

/** Sends one entry; true when the hub accepted it. */
async function sendEntry(deps: RunDeps, id: string, generation: string): Promise<boolean> {
  const { store } = deps;
  if (deps.stillCurrent && !deps.stillCurrent()) return false;
  // Another window may have finished or changed it since the list was read.
  const current = readJson<QueueEntry>(store, ENTRY_PREFIX + id);
  if (!current || current.status !== "pending") return false;
  if (current.generation !== generation) {
    saveEntry(store, { ...current, status: "attention", lastError: "This action belongs to an earlier database restore. Review the order." });
    return false;
  }
  let path = current.path;
  if (current.after) {
    const before = readResult(store, current.after)!;
    if (before.status !== "done") {
      saveEntry(store, { ...current, status: "attention", lastError: "An earlier step did not go through." });
      return false;
    }
    try { path = resolvePath(current.path, before.value); }
    catch (error) {
      saveEntry(store, { ...current, status: "attention", lastError: error instanceof Error ? error.message : "Could not continue" });
      return false;
    }
  }
  const attempt = deps.now();
  try {
    const value = await deps.send(current.method, path, current.body);
    clearAcknowledgedDraft(store, current);
    finish(store, current, { status: "done", value, at: deps.now() });
    return true;
  } catch (raw) {
    const failure = toFailure(raw);
    const attempts = current.attempts + 1;
    if (isRetryable(failure)) {
      saveEntry(store, { ...current, attempts, lastAttemptAt: attempt, nextAttemptAt: attempt + backoffMs(attempts, deps.random), lastError: failure.message });
    } else {
      // Kept for review rather than finished: staff decide whether to retry or discard it.
      saveEntry(store, { ...current, attempts, lastAttemptAt: attempt, status: "attention", lastError: failure.message });
      stopDependents(store, current.id, "An earlier step needs attention first.");
    }
    return false;
  }
}

function toFailure(error: unknown): SendFailure {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    const message = (error as { message?: unknown }).message;
    return { ...(typeof status === "number" ? { status } : {}), message: typeof message === "string" && message ? message : "Could not reach the server" };
  }
  return { message: "Could not reach the server" };
}

/** A punch is acknowledged only after the response: remove exactly the rows it carried, never newer cart rows. */
function clearAcknowledgedDraft(store: QueueStore, entry: QueueEntry): void {
  if (!entry.draftKey) return;
  try {
    const refs = new Set((JSON.parse(entry.body).items as Array<{ clientRef: string }>).map((item) => item.clientRef));
    const draft = JSON.parse(store.get(entry.draftKey) ?? "[]") as Array<{ clientRef: string }>;
    store.set(entry.draftKey, JSON.stringify(draft.filter((item) => !refs.has(item.clientRef))));
  } catch { /* an unreadable draft is left for the order screen to show */ }
}

/** Sends a stopped entry again on the next run. */
export function retryEntry(store: QueueStore, id: string, now: number): boolean {
  const entry = readJson<QueueEntry>(store, ENTRY_PREFIX + id);
  if (!entry) return false;
  saveEntry(store, { ...entry, status: "pending", nextAttemptAt: now });
  // Entries stopped only because of this one go back to waiting for it.
  for (const dependent of listEntries(store)) {
    if (dependent.after === id && dependent.status === "attention") saveEntry(store, { ...dependent, status: "pending", nextAttemptAt: now });
  }
  return true;
}

/** Gives up on an entry: it is never sent, whoever queued it is told, and anything waiting for it stops for review. */
export function discardEntry(store: QueueStore, id: string, now: number): boolean {
  const entry = readJson<QueueEntry>(store, ENTRY_PREFIX + id);
  if (!entry) return false;
  finish(store, entry, { status: "discarded", error: "Discarded by staff", at: now });
  stopDependents(store, id, "An earlier step was discarded.");
  return true;
}

/** Drops result records older than a day; their callers have long since heard. */
export function pruneResults(store: QueueStore, now: number): void {
  for (const key of store.keys()) {
    if (!key.startsWith(RESULT_PREFIX)) continue;
    const result = readJson<QueueResult>(store, key);
    if (!result || now - result.at > RESULT_TTL_MS) store.remove(key);
  }
}
