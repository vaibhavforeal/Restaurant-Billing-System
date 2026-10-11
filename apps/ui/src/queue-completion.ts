export const RESULT_PREFIX = "forkflow.queue-result.v1.";
export const RECOVERY_PREFIX = "forkflow.queue-recovery.v1.";
export const RECONCILIATION_MESSAGE = "This action may have completed in another window. Review the order before trying again.";
export type PrintOutcome = "not_requested" | "reported" | "unknown";
export type CompletionIdentity = { version: 1; requestId: string; attemptId: string; userId: string; generation: string; path: string; body: string; completedAt: number };
export type QueueCompletion = CompletionIdentity & (
  | { outcome: "success"; response: unknown; printOutcome: PrintOutcome }
  | { outcome: "rejected"; status: number; message: string; code?: string }
  | { outcome: "dismissed" }
);
export type ReliableResult<T> = T & { queueMeta: { requestId: string; printOutcome: PrintOutcome } };
export type CompletionMatch = Pick<CompletionIdentity, "requestId" | "userId" | "generation" | "path" | "body">;
export type StorageLike = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

function recordKey(record: CompletionIdentity) { return `${RESULT_PREFIX}${record.requestId}.${record.attemptId}`; }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
export function parseCompletion(raw: string | null, key: string): QueueCompletion | null {
  if (!raw || !key.startsWith(RESULT_PREFIX)) return null;
  try {
    const r = JSON.parse(raw) as Partial<QueueCompletion>;
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    const fields = new Set(["version", "requestId", "attemptId", "userId", "generation", "path", "body", "completedAt", "outcome", "response", "printOutcome", "status", "message", "code"]);
    if (Object.keys(r).some((field) => !fields.has(field))) return null;
    if (r.version !== 1 || !nonempty(r.requestId) || !nonempty(r.attemptId) || !nonempty(r.userId) ||
      !nonempty(r.generation) || !nonempty(r.path) || typeof r.body !== "string" ||
      !Number.isFinite(r.completedAt) || (r.completedAt ?? -1) < 0 || key !== recordKey(r as CompletionIdentity)) return null;
    if (r.outcome === "success") {
      if (!("response" in r) || !["not_requested", "reported", "unknown"].includes(r.printOutcome as string)) return null;
    } else if (r.outcome === "rejected") {
      if (!Number.isInteger(r.status) || (r.status ?? 0) < 400 || (r.status ?? 0) > 599 || !nonempty(r.message) || (r.code !== undefined && typeof r.code !== "string")) return null;
    } else if (r.outcome !== "dismissed") return null;
    return r as QueueCompletion;
  } catch { return null; }
}
export function allCompletions(storage: StorageLike): QueueCompletion[] {
  const records: QueueCompletion[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(RESULT_PREFIX)) continue;
    const record = parseCompletion(storage.getItem(key), key);
    if (record) records.push(record);
  }
  return records;
}
export function matchingCompletions(storage: StorageLike, request: CompletionMatch): QueueCompletion[] {
  return allCompletions(storage).filter((r) => r.requestId === request.requestId && r.userId === request.userId &&
    r.generation === request.generation && r.path === request.path && r.body === request.body);
}
export function selectCompletion(records: QueueCompletion[]): QueueCompletion | null {
  const successes = records.filter((r): r is QueueCompletion & { outcome: "success" } => r.outcome === "success");
  if (successes.length) return successes.sort((a, b) =>
    Number(b.printOutcome === "reported") - Number(a.printOutcome === "reported") || a.completedAt - b.completedAt || a.attemptId.localeCompare(b.attemptId))[0] ?? null;
  return records.sort((a, b) => a.completedAt - b.completedAt || a.attemptId.localeCompare(b.attemptId))[0] ?? null;
}
export function classifyPrintOutcome(path: string, body: unknown, response: unknown): PrintOutcome {
  if (/\/items$|\/settle$/.test(path)) return "not_requested";
  if (/\/send$/.test(path)) {
    if (Array.isArray((response as { printErrors?: unknown } | null)?.printErrors)) return "reported";
    return "unknown";
  }
  if (/\/bill$/.test(path)) {
    if (!(body as { printerId?: unknown } | null)?.printerId) return "not_requested";
    const value = response as { job?: unknown; printError?: unknown } | null;
    return value?.job || (typeof value?.printError === "string" && value.printError.trim()) ? "reported" : "unknown";
  }
  return "not_requested";
}

/** Remove expired, unreferenced request groups even when no new result is admitted. */
export function sweepExpiredCompletions(storage: StorageLike, protectedRequests: Set<string>, now = Date.now()): void {
  const groups = new Map<string, QueueCompletion[]>();
  for (const record of allCompletions(storage)) groups.set(record.requestId, [...(groups.get(record.requestId) ?? []), record]);
  for (const [id, records] of groups) {
    if (protectedRequests.has(id) || !records.every((record) => now - record.completedAt >= 24 * 60 * 60 * 1000)) continue;
    for (const record of records) storage.removeItem(recordKey(record));
  }
}

/** Admission is bounded by age, groups, and serialized bytes. Never split a request group. */
export function storeCompletion(storage: StorageLike, record: QueueCompletion, protectedRequests: Set<string>, now = Date.now()): void {
  const key = recordKey(record), serialized = JSON.stringify(record);
  const existing = storage.getItem(key);
  if (existing !== null) {
    if (existing !== serialized) throw new Error("Completion attempt changed");
    return;
  }
  const records = allCompletions(storage);
  const groups = new Map<string, QueueCompletion[]>();
  for (const item of records) groups.set(item.requestId, [...(groups.get(item.requestId) ?? []), item]);
  const evict = (id: string) => {
    for (const item of groups.get(id) ?? []) storage.removeItem(recordKey(item));
    groups.delete(id);
  };
  for (const [id, items] of groups) {
    if (!protectedRequests.has(id) && items.every((item) => now - item.completedAt >= 24 * 60 * 60 * 1000)) evict(id);
  }
  const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
  const size = () => byteLength(serialized) + [...groups.values()].flat().reduce((sum, item) => sum + byteLength(JSON.stringify(item)), 0);
  const count = () => groups.size + (groups.has(record.requestId) ? 0 : 1);
  while (count() > 100 || size() > 1024 * 1024) {
    const candidate = [...groups.entries()].filter(([id]) => id !== record.requestId && !protectedRequests.has(id))
      .sort((a, b) => Math.min(...a[1].map((r) => r.completedAt)) - Math.min(...b[1].map((r) => r.completedAt)))[0];
    if (!candidate) throw new Error("Completion storage capacity exhausted");
    evict(candidate[0]);
  }
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error("Completion storage acknowledgement failed");
}
