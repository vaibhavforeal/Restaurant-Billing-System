import { ApiError, apiFetch, session } from "./api";
import {
  ENTRY_PREFIX, discardEntry, dueEntries, listEntries, pruneResults, readResult, retryEntry, runDue, saveEntry,
  type QueueEntry, type QueueStore,
} from "./queue-core";
import { uuid } from "./uuid";

/**
 * The browser side of the offline queue (rules in queue-core.ts). Actions are saved to localStorage before they are
 * sent; one window at a time sends them; whoever queued an action hears its outcome in any window, even after a reload.
 */
export type QueuedRequest = QueueEntry & {
  /** Set while the hub refused the action and it waits for review. */
  error?: string;
};

const V1_PREFIX = "masalapos.queue.v1.";
const GENERATION = "masalapos.generation";
const LEASE = "masalapos.queue-lease";
/** How often the queue checks in with the hub even with nothing to send, which also keeps the connection status honest. */
const CHECK_MS = 5000;

const store: QueueStore = {
  get: (key) => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  remove: (key) => localStorage.removeItem(key),
  keys: () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => k !== null),
};

function isEmptyKitchenSend(path: string, body: unknown): boolean {
  if (!/^\/api\/orders\/[^/]+\/send$/.test(path) || !body || typeof body !== "object") return false;
  const itemIds = (body as { itemIds?: unknown }).itemIds;
  return Array.isArray(itemIds) && itemIds.length === 0;
}

/** What may be saved and sent later: every request here is safe to repeat (the hub ignores repeats by reference). */
const QUEUEABLE: Record<"POST" | "PATCH", RegExp> = {
  POST: /^\/api\/(orders|orders\/[^/]+\/(items|send|bill|cancel)|order-items\/[^/]+\/(cancel|edit-sent)|bills\/([^/]+|\{after:[a-zA-Z.]+\})\/settle)$/,
  PATCH: /^\/api\/orders\/[^/]+\/(captain|customer|order-type)$/,
};

/** Which lane an action goes in: its order, so one order's actions stay in order and other orders never wait. */
function laneFor(path: string, body: unknown): string | null {
  const order = /^\/api\/orders\/([^/]+)\//.exec(path);
  if (order) return order[1]!;
  if (path === "/api/orders" && body && typeof body === "object") {
    const created = body as { id?: unknown; clientRef?: unknown };
    if (typeof created.id === "string") return created.id;
    if (typeof created.clientRef === "string") return `new:${created.clientRef}`;
  }
  const bill = /^\/api\/bills\/([^/{]+)\/settle$/.exec(path);
  return bill ? `bill:${bill[1]}` : null;
}

let actor: string | null = null;
let generationChecked = false;
let pumping = false;
const windowId = uuid();
const listeners = new Set<() => void>();
const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

export function notifyQueue() { listeners.forEach((listener) => listener()); }
export function subscribeQueue(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function queueConnected() { return generationChecked; }

export function queuedRequests(userId = actor): QueuedRequest[] {
  return listEntries(store, userId ?? null).map((entry) => entry.status === "attention" ? { ...entry, error: entry.lastError ?? "Needs review" } : entry);
}

/** Sends a stopped action again. */
export function retryRequest(id: string) {
  if (retryEntry(store, id, Date.now())) { notifyQueue(); void pump(); }
}
/** Gives up on an action: it is never sent. The screens ask first when it may already have reached the hub. */
export function discardRequest(id: string) {
  if (discardEntry(store, id, Date.now())) { settleWaiters(); notifyQueue(); }
}

/** A request the hub refused, kept for review: the caller hears why, the action stays in the saved list. */
export class QueueAttentionError extends Error {}

/** Settles every waiting caller whose action has finished or stopped for review, whichever window sent it. */
function settleWaiters() {
  for (const [id, waiter] of waiters) {
    const result = readResult(store, id);
    if (result) {
      waiters.delete(id);
      if (result.status === "done") waiter.resolve(result.value);
      else waiter.reject(new Error(result.status === "discarded" ? "This saved action was discarded." : result.error ?? "The action was refused."));
      continue;
    }
    const raw = store.get(ENTRY_PREFIX + id);
    if (!raw) continue;
    try {
      const entry = JSON.parse(raw) as QueueEntry;
      if (entry.status === "attention") { waiters.delete(id); waiter.reject(new QueueAttentionError(entry.lastError ?? "Needs review")); }
    } catch { /* an unreadable entry stays for review */ }
  }
}

/** Moves actions saved by the previous version of the queue into this one. */
function migrateV1() {
  for (const key of store.keys()) {
    if (!key.startsWith(V1_PREFIX)) continue;
    try {
      const old = JSON.parse(store.get(key)!) as { id: string; userId: string; generation: string; path: string; body: string; label: string; createdAt: number; error?: string; draftKey?: string };
      let body: unknown = null;
      try { body = JSON.parse(old.body); } catch { /* kept as text */ }
      const entry: QueueEntry = {
        id: old.id, userId: old.userId, generation: old.generation, method: "POST", path: old.path, body: old.body, label: old.label,
        lane: laneFor(old.path, body) ?? old.id, createdAt: old.createdAt, status: old.error ? "attention" : "pending", attempts: 0,
        lastAttemptAt: null, nextAttemptAt: 0, ...(old.error ? { lastError: old.error } : {}), ...(old.draftKey ? { draftKey: old.draftKey } : {}),
      };
      saveEntry(store, entry);
      store.remove(key);
    } catch { /* leave a damaged old entry where it is for inspection */ }
  }
}

export function startQueue(userId: string) {
  actor = userId; generationChecked = false;
  migrateV1();
  // Older KOT buttons queued empty item lists. These refused requests cannot create a ticket; remove only those.
  for (const entry of queuedRequests(userId)) {
    try { if (entry.status === "attention" && isEmptyKitchenSend(entry.path, JSON.parse(entry.body))) discardEntry(store, entry.id, Date.now()); }
    catch { /* keep unreadable requests for review */ }
  }
  // Another window saved, sent or finished something: refresh, hear outcomes, and help send if it is now due.
  const onStorage = (event: StorageEvent) => {
    if (event.key && !event.key.startsWith("masalapos.")) return;
    settleWaiters(); notifyQueue();
    if (actor && dueEntries(store, actor, Date.now()).length) void pump();
  };
  window.addEventListener("storage", onStorage);
  void pump();
  let lastCheck = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (actor && (dueEntries(store, actor, now).length || now - lastCheck >= CHECK_MS)) { lastCheck = now; void pump(); }
  }, 1000);
  return () => {
    clearInterval(timer); window.removeEventListener("storage", onStorage); actor = null; generationChecked = false;
    for (const waiter of waiters.values()) waiter.reject(new Error("Request saved. Sign in as the same staff member to resume."));
    waiters.clear();
  };
}

export interface QueueRequest {
  method?: "POST" | "PATCH";
  path: string;
  body: unknown;
  label: string;
  /** The cart draft whose rows an item punch carries. */
  draftKey?: string;
  /** Wait for an earlier action and use its result in `path` (`{after:bill.id}`). */
  after?: string;
  /** The lane, when the path does not name the order (item actions, a chained payment). */
  lane?: string;
  context?: QueueEntry["context"];
}

/**
 * Saves an action and sends it as soon as the hub can be reached. Returns its id at once (to chain later steps on it)
 * and a promise for the hub's reply, which settles even if another window sends it or the page reloads in between.
 */
export function enqueueRequest<T>(request: QueueRequest): { id: string; done: Promise<T> } {
  const method = request.method ?? "POST";
  const fail = (message: string) => ({ id: "", done: Promise.reject(new Error(message)) as Promise<T> });
  if (isEmptyKitchenSend(request.path, request.body)) return fail("No items are waiting for a kitchen ticket.");
  if (!actor || !localStorage.getItem(GENERATION)) return fail("Waiting for the server connection. Try again shortly.");
  if (!QUEUEABLE[method].test(request.path)) return fail("This action cannot be queued");
  const body = JSON.stringify(request.body);
  // The same request twice (a double tap) is one action.
  const duplicate = queuedRequests().find((r) => r.method === method && r.path === request.path && r.body === body);
  if (duplicate) return fail(`A saved ${duplicate.label} request needs to finish or be reviewed first.`);
  const lane = request.lane ?? laneFor(request.path, request.body);
  if (!lane) return fail("This action cannot be queued");
  const now = Date.now();
  // Lanes run in saved order; two actions saved in the same millisecond must still keep theirs.
  const createdAt = Math.max(now, ...listEntries(store).map((e) => e.createdAt + 1));
  const entry: QueueEntry = {
    id: uuid(), userId: actor, generation: localStorage.getItem(GENERATION)!, method, path: request.path, body, label: request.label, lane,
    createdAt, status: "pending", attempts: 0, lastAttemptAt: null, nextAttemptAt: now,
    ...(request.draftKey ? { draftKey: request.draftKey } : {}), ...(request.after ? { after: request.after } : {}), ...(request.context ? { context: request.context } : {}),
  };
  try { saveEntry(store, entry); }
  catch { return fail("Browser storage is full or unavailable. Request was not sent."); }
  const done = new Promise<T>((resolve, reject) => waiters.set(entry.id, { resolve: (value) => resolve(value as T), reject }));
  notifyQueue(); void pump();
  return { id: entry.id, done };
}

export function reliablePost<T>(path: string, body: unknown, label: string, draftKey?: string): Promise<T> {
  return enqueueRequest<T>({ path, body, label, ...(draftKey ? { draftKey } : {}) }).done;
}

export type Outcome<T> = { saved: false; value: T } | { saved: true };
/**
 * The hub's reply when it answers promptly; otherwise `saved` once the action is plainly waiting (the hub could not be
 * reached, or an earlier action for the same order holds it up), so the screen can carry on. A later refusal shows in
 * the saved-actions list rather than on a screen the person may have left.
 */
export function outcomeOrSaved<T>(handle: { id: string; done: Promise<T> }, patienceMs = 4000): Promise<Outcome<T>> {
  handle.done.catch(() => { /* reported in the saved-actions list */ });
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (settle: () => void) => { if (finished) return; finished = true; clearTimeout(timer); unsubscribe(); settle(); };
    const check = () => {
      const entries = listEntries(store, actor);
      const entry = entries.find((e) => e.id === handle.id);
      if (!entry || entry.status !== "pending") return;
      const heldUp = entries.some((e) => e.lane === entry.lane && e.id !== entry.id && (e.createdAt < entry.createdAt) && (e.attempts > 0 || e.status === "attention"));
      // The last check-in could not reach the hub at all, so nothing was even tried.
      const unreachable = !generationChecked && !pumping;
      if (entry.attempts > 0 || heldUp || unreachable) finish(() => resolve({ saved: true }));
    };
    const unsubscribe = subscribeQueue(check);
    const timer = setTimeout(() => finish(() => resolve({ saved: true })), patienceMs);
    handle.done.then((value) => finish(() => resolve({ saved: false, value })), (error: Error) => finish(() => reject(error)));
    check();
  });
}

/** Runs `fn` in at most one window at a time: a Web Lock where available, otherwise a short localStorage lease. */
async function exclusively(fn: () => Promise<void>): Promise<void> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks?.request) {
    await locks.request("masalapos-queue", { ifAvailable: true }, async (lock) => { if (lock) await fn(); });
    return;
  }
  const now = Date.now();
  try {
    const lease = JSON.parse(store.get(LEASE) ?? "null") as { owner: string; until: number } | null;
    if (lease && lease.owner !== windowId && lease.until > now) return;
  } catch { /* a damaged lease is taken over */ }
  store.set(LEASE, JSON.stringify({ owner: windowId, until: now + 30_000 }));
  try { await fn(); } finally { store.remove(LEASE); }
}

async function pump() {
  if (pumping || !actor || !session.token) return;
  pumping = true;
  const userId = actor, token = session.token;
  const stillCurrent = () => actor === userId && session.token === token;
  try {
    await exclusively(async () => {
      const { generation } = await apiFetch<{ generation: string }>("/api/system/generation");
      if (!stillCurrent()) return;
      const previous = localStorage.getItem(GENERATION);
      if (previous && previous !== generation) {
        // Keep a readable archive, but never replay drafts or actions from before a restore point.
        const saved: Record<string, string> = {};
        for (const key of store.keys()) if (key.startsWith("masalapos.draft.") || key.startsWith(ENTRY_PREFIX)) saved[key] = store.get(key)!;
        localStorage.setItem(`masalapos.recovery-archive.${Date.now()}`, JSON.stringify(saved));
        Object.keys(saved).forEach((key) => store.remove(key));
        localStorage.setItem(GENERATION, generation);
        window.alert("The server was restored from backup. Saved drafts and queued actions were archived for review. Sign in again and check your open orders.");
        location.reload(); return;
      }
      localStorage.setItem(GENERATION, generation); generationChecked = true;
      const before = listEntries(store, userId);
      await runDue({
        store, now: Date.now, random: Math.random, stillCurrent,
        send: (method, path, body) => apiFetch(path, { method, body }),
      }, userId, generation);
      pruneResults(store, Date.now());
      for (const entry of before) {
        if (readResult(store, entry.id)?.status === "done") window.dispatchEvent(new CustomEvent("masalapos:ack", { detail: entry }));
      }
    });
  } catch (error) {
    // The hub could not be reached for the generation check: the actions stay saved.
    if (!(error instanceof ApiError) || error.status >= 500) generationChecked = false;
  } finally {
    pumping = false;
    settleWaiters();
    notifyQueue();
  }
}
