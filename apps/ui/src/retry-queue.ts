import { outletStorage } from "./outlet-identity";
import { ApiError, apiFetch, session } from "./api";
import { uuid } from "./uuid";
import { RECOVERY_PREFIX, RECONCILIATION_MESSAGE, RESULT_PREFIX, classifyPrintOutcome, matchingCompletions, selectCompletion, storeCompletion, sweepExpiredCompletions, type QueueCompletion, type ReliableResult } from "./queue-completion";

export interface QueuedRequest {
  id: string; userId: string; generation: string; path: string; body: string;
  label: string; createdAt: number; error?: string; draftKey?: string;
}
type Waiter = { entry: QueuedRequest; lifecycle: number; token: string | null; resolve: (value: unknown) => void; reject: (error: Error) => void };
type RecoveryRecord = { entry: QueuedRequest; reason: string; savedAt: number };
type LocalSuccess = { completion: QueueCompletion; lifecycle: number; token: string | null };
const PREFIX = "forkflow.queue.v1.";
const GENERATION = "forkflow.generation";
export const PRINT_UNKNOWN = "Order saved; printing could not be confirmed. Check the printer before printing again.";
export class QueueReconciliationRequiredError extends Error { constructor() { super(RECONCILIATION_MESSAGE); this.name = "QueueReconciliationRequiredError"; } }

function isEmptyKitchenSend(path: string, body: unknown): boolean {
  return /^\/api\/orders\/[^/]+\/send$/.test(path) && !!body && typeof body === "object" &&
    Array.isArray((body as { itemIds?: unknown }).itemIds) && (body as { itemIds: unknown[] }).itemIds.length === 0;
}
let actor: string | null = null, running = false, generationChecked = false, lifecycle = 0;
const listeners = new Set<() => void>();
const waiters = new Map<string, Waiter>();
const localSuccess = new Map<string, LocalSuccess>();
const localRecovery = new Map<string, RecoveryRecord>();
const deliveredPrint = new Map<string, "not_requested" | "reported" | "unknown">();
const delivered = new Map<string, { entry: QueuedRequest; outcome: QueueCompletion["outcome"] | "recovery"; token: string | null; lifecycle: number }>();
const reviewedSuccess = new Set<string>();
export function notifyQueue() { listeners.forEach((listener) => listener()); }
export function subscribeQueue(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function storageKeys(prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < outletStorage.length; i++) { const key = outletStorage.key(i); if (key?.startsWith(prefix)) keys.push(key); }
  return keys;
}
export function queuedRequests(userId = actor): QueuedRequest[] {
  const entries: QueuedRequest[] = [];
  for (const key of storageKeys(PREFIX)) {
    try {
      const entry = JSON.parse(outletStorage.getItem(key)!) as QueuedRequest;
      if (entry.id && key === PREFIX + entry.id && entry.userId === userId) entries.push(entry);
    } catch { /* preserve damaged evidence for review */ }
  }
  return entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export function recoveryRequests(userId = actor): RecoveryRecord[] {
  const records = new Map<string, RecoveryRecord>([...localRecovery].filter(([, r]) => r.entry.userId === userId));
  for (const key of storageKeys(RECOVERY_PREFIX)) {
    try {
      const value = JSON.parse(outletStorage.getItem(key)!) as RecoveryRecord;
      if (value.entry?.userId === userId && key === RECOVERY_PREFIX + value.entry.id) records.set(value.entry.id, value);
    } catch { /* damaged evidence remains in storage */ }
  }
  return [...records.values()].sort((a, b) => a.savedAt - b.savedAt);
}
function saveRecovery(entry: QueuedRequest, reason = RECONCILIATION_MESSAGE) {
  const alreadySaved = localRecovery.has(entry.id);
  const record = { entry, reason, savedAt: Date.now() };
  localRecovery.set(entry.id, record);
  try { outletStorage.setItem(RECOVERY_PREFIX + entry.id, JSON.stringify(record)); } catch { /* retain in memory */ }
  notifyQueue();
  if (!alreadySaved) window.dispatchEvent(new CustomEvent("forkflow:queue-review", { detail: { requestId: entry.id, path: entry.path, message: reason } }));
}
function protectedRequests(): Set<string> {
  return new Set([...storageKeys(PREFIX).map((key) => key.slice(PREFIX.length)), ...waiters.keys(), ...localSuccess.keys()]);
}
function completionFor(entry: QueuedRequest) {
  return selectCompletion(matchingCompletions(outletStorage, { requestId: entry.id, userId: entry.userId, generation: entry.generation, path: entry.path, body: entry.body })
    .filter((record) => Date.now() - record.completedAt < 24 * 60 * 60 * 1000));
}
function expiredCompletion(entry: QueuedRequest) {
  return matchingCompletions(outletStorage, { requestId: entry.id, userId: entry.userId, generation: entry.generation, path: entry.path, body: entry.body })
    .some((record) => Date.now() - record.completedAt >= 24 * 60 * 60 * 1000);
}
function resultFor<T>(entry: QueuedRequest, completion: QueueCompletion): ReliableResult<T> {
  if (completion.outcome !== "success") throw new QueueReconciliationRequiredError();
  return { ...(completion.response as object), queueMeta: { requestId: entry.id, printOutcome: completion.printOutcome } } as ReliableResult<T>;
}
function settle(entry: QueuedRequest, completion: QueueCompletion) {
  const waiter = waiters.get(entry.id);
  if (waiter && waiter.lifecycle === lifecycle && waiter.token === session.token && actor === entry.userId) {
    waiters.delete(entry.id);
    delivered.set(entry.id, { entry, outcome: completion.outcome, token: waiter.token, lifecycle: waiter.lifecycle });
    if (completion.outcome === "success") {
      waiter.resolve(resultFor(entry, completion));
      deliveredPrint.set(entry.id, completion.printOutcome);
    } else if (completion.outcome === "rejected") waiter.reject(new ApiError(completion.status, completion.message, completion.code));
    else waiter.reject(new QueueReconciliationRequiredError());
  }
  const previousResult = delivered.get(entry.id);
  if (previousResult && (previousResult.token !== session.token || previousResult.lifecycle !== lifecycle)) return;
  if (completion.outcome === "success" && previousResult && previousResult.outcome !== "success" && !reviewedSuccess.has(entry.id)) {
    reviewedSuccess.add(entry.id);
    if (!localRecovery.has(entry.id)) saveRecovery(entry);
    else window.dispatchEvent(new CustomEvent("forkflow:queue-review", { detail: { requestId: entry.id, path: entry.path, message: RECONCILIATION_MESSAGE } }));
  }
  if (completion.outcome === "success") {
    const previous = deliveredPrint.get(entry.id);
    if (previous === "unknown" && completion.printOutcome === "reported") {
      deliveredPrint.set(entry.id, "reported");
      window.dispatchEvent(new CustomEvent("forkflow:queue-feedback", { detail: { requestId: entry.id, path: entry.path, printOutcome: "reported", response: completion.response } }));
    }
  }
  notifyQueue();
}
function cleanDraft(entry: QueuedRequest) {
  if (!entry.draftKey) return;
  const items = (JSON.parse(entry.body) as { items?: Array<{ clientRef: string }> }).items ?? [];
  const refs = new Set(items.map((item) => item.clientRef));
  const draft = JSON.parse(outletStorage.getItem(entry.draftKey) ?? "[]") as Array<{ clientRef: string }>;
  const cleaned = draft.filter((item) => !refs.has(item.clientRef));
  if (cleaned.length !== draft.length) {
    const serialized = JSON.stringify(cleaned);
    outletStorage.setItem(entry.draftKey, serialized);
    if (outletStorage.getItem(entry.draftKey) !== serialized) throw new Error("Draft cleanup was not acknowledged");
  }
}
function finishSuccess(entry: QueuedRequest, completion: QueueCompletion) {
  if (completion.outcome !== "success") return;
  const pending = outletStorage.getItem(PREFIX + entry.id) !== null;
  if (pending) {
    cleanDraft(entry);
    outletStorage.removeItem(PREFIX + entry.id);
    if (outletStorage.getItem(PREFIX + entry.id) !== null) throw new Error("Pending removal was not acknowledged");
  }
  localSuccess.delete(entry.id);
  settle(entry, completion);
  if (pending) window.dispatchEvent(new CustomEvent("forkflow:ack", { detail: entry }));
}
function finishTerminal(entry: QueuedRequest, completion: QueueCompletion) {
  outletStorage.removeItem(PREFIX + entry.id);
  if (outletStorage.getItem(PREFIX + entry.id) !== null) throw new Error("Pending removal was not acknowledged");
  settle(entry, completion);
}
function failReconciliation(entry: QueuedRequest) {
  const waiter = waiters.get(entry.id);
  if (waiter) { waiters.delete(entry.id); delivered.set(entry.id, { entry, outcome: "recovery", token: waiter.token, lifecycle: waiter.lifecycle }); waiter.reject(new QueueReconciliationRequiredError()); }
  saveRecovery(entry);
}
export function reconcileWaiters() {
  for (const [id, waiter] of [...waiters]) {
    if (waiter.lifecycle !== lifecycle || waiter.token !== session.token || actor !== waiter.entry.userId) {
      waiters.delete(id); waiter.reject(new Error("Request saved. Sign in as the same staff member to resume.")); continue;
    }
    if (waiter.entry.generation !== outletStorage.getItem(GENERATION)) { failReconciliation(waiter.entry); continue; }
    if (recoveryRequests(actor).some((record) => record.entry.id === id)) { failReconciliation(waiter.entry); continue; }
    let completion: QueueCompletion | null;
    try { completion = completionFor(waiter.entry); } catch { continue; }
    if (completion?.outcome === "success") {
      try { finishSuccess(waiter.entry, completion); } catch { failReconciliation(waiter.entry); }
    } else if (completion) { try { finishTerminal(waiter.entry, completion); } catch { failReconciliation(waiter.entry); } }
    else if (outletStorage.getItem(PREFIX + id) === null || expiredCompletion(waiter.entry)) failReconciliation(waiter.entry);
  }
  for (const [id, saved] of [...localSuccess]) {
    const { completion: evidence } = saved;
    if (waiters.has(id) || actor !== evidence.userId || !session.token || saved.token !== session.token ||
      saved.lifecycle !== lifecycle || evidence.generation !== outletStorage.getItem(GENERATION)) continue;
    const entry = queuedRequests(actor).find((r) => r.id === id) ?? localRecovery.get(id)?.entry ?? delivered.get(id)?.entry;
    if (!entry) continue;
    try {
      storeCompletion(outletStorage, evidence, protectedRequests());
      const confirmed = completionFor(entry);
      if (confirmed?.outcome === "success") finishSuccess(entry, confirmed);
    } catch { saveRecovery(entry); }
  }
  for (const { entry, token, lifecycle: deliveredLifecycle } of delivered.values()) {
    if (actor !== entry.userId || !session.token || session.token !== token || deliveredLifecycle !== lifecycle || entry.generation !== outletStorage.getItem(GENERATION)) continue;
    try { const completion = completionFor(entry); if (completion) settle(entry, completion); } catch { /* next tick can retry reading feedback */ }
  }
  // Feedback has no continuation; retain only the bounded set of durable groups.
  if (delivered.size > 100) for (const id of [...delivered.keys()].slice(0, delivered.size - 100)) { delivered.delete(id); deliveredPrint.delete(id); reviewedSuccess.delete(id); }
  try { sweepExpiredCompletions(outletStorage, protectedRequests()); } catch { /* preserve evidence when storage cannot evict it */ }
}
export function discardRequest(id: string) {
  const entry = queuedRequests().find((r) => r.id === id);
  if (!entry?.error) return;
  const record: QueueCompletion = { version: 1, requestId: id, attemptId: uuid(), userId: entry.userId, generation: entry.generation,
    path: entry.path, body: entry.body, completedAt: Date.now(), outcome: "dismissed" };
  try {
    storeCompletion(outletStorage, record, protectedRequests());
    const selected = completionFor(entry) ?? record;
    if (selected.outcome === "success") finishSuccess(entry, selected);
    else finishTerminal(entry, selected);
  } catch { saveRecovery(entry); }
}
export function startQueue(userId: string) {
  const current = ++lifecycle;
  actor = userId; generationChecked = false;
  for (const entry of queuedRequests(userId)) {
    try { if (entry.error && isEmptyKitchenSend(entry.path, JSON.parse(entry.body))) discardRequest(entry.id); }
    catch { /* retain malformed evidence */ }
  }
  const onStorage = () => { reconcileWaiters(); notifyQueue(); void pump(); };
  window.addEventListener("storage", onStorage);
  reconcileWaiters(); void pump();
  const timer = setInterval(() => { reconcileWaiters(); void pump(); }, 3000);
  return () => {
    if (lifecycle !== current) return;
    ++lifecycle; clearInterval(timer); window.removeEventListener("storage", onStorage);
    actor = null; generationChecked = false;
    for (const waiter of waiters.values()) waiter.reject(new Error("Request saved. Sign in as the same staff member to resume."));
    waiters.clear(); delivered.clear(); deliveredPrint.clear(); reviewedSuccess.clear(); localSuccess.clear(); localRecovery.clear(); notifyQueue();
  };
}
export function reliablePost<T>(path: string, body: unknown, label: string, draftKey?: string): Promise<ReliableResult<T>> {
  if (isEmptyKitchenSend(path, body)) return Promise.reject(new Error("No items are waiting for a kitchen ticket."));
  if (!actor || !outletStorage.getItem(GENERATION)) return Promise.reject(new Error("Waiting for the server connection. Try again shortly."));
  if (!/^\/api\/(orders\/[^/]+\/(items|send|bill)|bills\/[^/]+\/settle)$/.test(path)) return Promise.reject(new Error("This action cannot be queued"));
  const existing = queuedRequests().find((r) => r.path === path);
  if (existing) return Promise.reject(new Error(`A saved ${existing.label} request needs to finish or be reviewed first.`));
  if (recoveryRequests().some((r) => r.entry.path === path)) return Promise.reject(new QueueReconciliationRequiredError());
  let serialized: string;
  try { serialized = JSON.stringify(body); if (serialized === undefined) throw new Error(); }
  catch { return Promise.reject(new Error("Request could not be saved.")); }
  const entry: QueuedRequest = { id: uuid(), userId: actor, generation: outletStorage.getItem(GENERATION)!, path, body: serialized, label, createdAt: Date.now(), ...(draftKey ? { draftKey } : {}) };
  try { outletStorage.setItem(PREFIX + entry.id, JSON.stringify(entry)); }
  catch { return Promise.reject(new Error("Browser storage is full or unavailable. Request was not sent.")); }
  const result = new Promise<ReliableResult<T>>((resolve, reject) => waiters.set(entry.id, { entry, lifecycle, token: session.token, resolve: (value) => resolve(value as ReliableResult<T>), reject }));
  notifyQueue(); void pump(); return result;
}
function archiveGeneration(next: string) {
  const keys = [...new Set([...storageKeys("forkflow.draft."), ...storageKeys(PREFIX), ...storageKeys(RESULT_PREFIX), ...storageKeys(RECOVERY_PREFIX)])];
  const saved: Record<string, string> = {};
  for (const key of keys) { const value = outletStorage.getItem(key); if (value !== null) saved[key] = value; }
  const archiveKey = `forkflow.recovery-archive.${Date.now()}`;
  const archive = JSON.stringify(saved);
  outletStorage.setItem(archiveKey, archive);
  if (outletStorage.getItem(archiveKey) !== archive) throw new Error("Archive was not acknowledged");
  for (const key of keys) outletStorage.removeItem(key);
  outletStorage.setItem(GENERATION, next);
  for (const waiter of waiters.values()) waiter.reject(new QueueReconciliationRequiredError());
  waiters.clear(); localSuccess.clear(); localRecovery.clear(); delivered.clear(); deliveredPrint.clear(); reviewedSuccess.clear();
  window.alert("The server was restored from backup. Saved drafts and queued actions were archived for review. Sign in again and check your open orders.");
  location.reload();
}
async function pump() {
  reconcileWaiters();
  if (running || !actor || !session.token) return;
  running = true;
  const userId = actor, token = session.token, runId = lifecycle;
  const generationBeforeCheck = outletStorage.getItem(GENERATION);
  const valid = (generation?: string) => actor === userId && session.token === token && lifecycle === runId &&
    (!generation || outletStorage.getItem(GENERATION) === generation);
  try {
    const { generation } = await apiFetch<{ generation: string }>("/api/system/generation");
    if (!valid() || outletStorage.getItem(GENERATION) !== generationBeforeCheck) return;
    const previous = outletStorage.getItem(GENERATION);
    if (previous && previous !== generation) { archiveGeneration(generation); return; }
    outletStorage.setItem(GENERATION, generation); generationChecked = true;
    reconcileWaiters();
    for (const snapshot of queuedRequests(userId)) {
      if (!valid(generation)) break;
      const entry = queuedRequests(userId).find((r) => r.id === snapshot.id);
      if (!entry || entry.error) continue;
      if (entry.generation !== generation) { saveRecovery(entry); continue; }
      const completed = completionFor(entry);
      if (completed?.outcome === "success") { try { finishSuccess(entry, completed); } catch { failReconciliation(entry); } continue; }
      if (completed) { try { finishTerminal(entry, completed); } catch { failReconciliation(entry); } continue; }
      if (expiredCompletion(entry)) { failReconciliation(entry); continue; }
      if (localSuccess.has(entry.id)) { reconcileWaiters(); continue; }
      if (recoveryRequests(userId).some((record) => record.entry.id === entry.id)) continue;
      const attemptId = uuid();
      try {
        const response = await apiFetch<unknown>(entry.path, { method: "POST", body: entry.body });
        if (!valid(generation)) break;
        const evidence: QueueCompletion = { version: 1, requestId: entry.id, attemptId, userId: entry.userId, generation: entry.generation,
          path: entry.path, body: entry.body, completedAt: Date.now(), outcome: "success", response,
          printOutcome: classifyPrintOutcome(entry.path, JSON.parse(entry.body), response) };
        localSuccess.set(entry.id, { completion: evidence, lifecycle: runId, token });
        try {
          storeCompletion(outletStorage, evidence, protectedRequests());
          const confirmed = completionFor(entry);
          if (!confirmed?.outcome || confirmed.outcome !== "success") throw new Error("Completion not acknowledged");
          finishSuccess(entry, confirmed);
        } catch { failReconciliation(entry); break; }
      } catch (error) {
        if (!valid(generation)) break;
        if (!(error instanceof ApiError) || error.status >= 500 || error.status === 401 || error.status === 429) break;
        const evidence: QueueCompletion = { version: 1, requestId: entry.id, attemptId, userId: entry.userId, generation: entry.generation,
          path: entry.path, body: entry.body, completedAt: Date.now(), outcome: "rejected", status: error.status, message: error.message,
          ...(error.code ? { code: error.code } : {}) };
        try {
          storeCompletion(outletStorage, evidence, protectedRequests());
          const selected = completionFor(entry) ?? evidence;
          if (selected.outcome === "success") finishSuccess(entry, selected);
          else finishTerminal(entry, selected);
        }
        catch { failReconciliation(entry); break; }
      }
      notifyQueue();
    }
  } catch { if (valid()) generationChecked = false; }
  finally {
    running = false;
    if (valid()) notifyQueue();
    else if (actor && session.token) void pump();
  }
}
export function queueConnected() { return generationChecked; }
