import { ApiError, apiFetch, session } from "./api";
import { uuid } from "./uuid";

export interface QueuedRequest {
  id: string; userId: string; generation: string; path: string; body: string;
  label: string; createdAt: number; error?: string; draftKey?: string;
}
const PREFIX = "forkflow.queue.v1.";
const GENERATION = "forkflow.generation";
let actor: string | null = null;
let running = false;
let generationChecked = false;
const listeners = new Set<() => void>();
const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
export function notifyQueue() { listeners.forEach((listener) => listener()); }
export function subscribeQueue(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function queuedRequests(userId = actor): QueuedRequest[] {
  const entries: QueuedRequest[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try { const entry = JSON.parse(localStorage.getItem(key)!); if (entry.userId === userId) entries.push(entry); } catch { /* leave damaged entry for inspection */ }
  }
  return entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export function discardRequest(id: string) {
  const entry = queuedRequests().find((r) => r.id === id);
  if (!entry?.error) return; // an ambiguous request must be reconciled with the server
  localStorage.removeItem(PREFIX + id); notifyQueue();
}
export function startQueue(userId: string) {
  actor = userId; generationChecked = false;
  const onStorage = () => notifyQueue();
  window.addEventListener("storage", onStorage);
  void pump();
  const timer = setInterval(() => { void pump(); }, 3000);
  return () => {
    clearInterval(timer); window.removeEventListener("storage", onStorage); actor = null; generationChecked = false;
    for (const waiter of waiters.values()) waiter.reject(new Error("Request saved. Sign in as the same staff member to resume."));
    waiters.clear();
  };
}
export function reliablePost<T>(path: string, body: unknown, label: string, draftKey?: string): Promise<T> {
  if (!actor || !localStorage.getItem(GENERATION)) return Promise.reject(new Error("Waiting for the server connection. Try again shortly."));
  if (!/^\/api\/(orders\/[^/]+\/(items|send|bill)|bills\/[^/]+\/settle)$/.test(path)) return Promise.reject(new Error("This action cannot be queued"));
  const existing = queuedRequests().find((r) => r.path === path);
  if (existing) return Promise.reject(new Error(`A saved ${existing.label} request needs to finish or be reviewed first.`));
  const entry: QueuedRequest = { id: uuid(), userId: actor, generation: localStorage.getItem(GENERATION)!, path, body: JSON.stringify(body), label, createdAt: Date.now(), ...(draftKey ? { draftKey } : {}) };
  try { localStorage.setItem(PREFIX + entry.id, JSON.stringify(entry)); }
  catch { return Promise.reject(new Error("Browser storage is full or unavailable. Request was not sent.")); }
  const result = new Promise<T>((resolve, reject) => waiters.set(entry.id, { resolve: (value) => resolve(value as T), reject }));
  notifyQueue(); void pump();
  return result;
}
async function pump() {
  if (running || !actor || !session.token) return;
  running = true;
  const userId = actor, token = session.token;
  try {
    const { generation } = await apiFetch<{ generation: string }>("/api/system/generation");
    if (actor !== userId || session.token !== token) return;
    const previous = localStorage.getItem(GENERATION);
    if (previous && previous !== generation) {
      // Keep a readable archive, but never replay drafts created after a restore point.
      const saved: Record<string, string> = {};
      for (const key of Object.keys(localStorage)) if (key.startsWith("forkflow.draft.") || key.startsWith(PREFIX)) saved[key] = localStorage.getItem(key)!;
      localStorage.setItem(`forkflow.recovery-archive.${Date.now()}`, JSON.stringify(saved));
      Object.keys(saved).forEach((key) => localStorage.removeItem(key));
      localStorage.setItem(GENERATION, generation);
      window.alert("The server was restored from backup. Saved drafts and queued actions were archived for review. Sign in again and check your open orders.");
      location.reload(); return;
    }
    localStorage.setItem(GENERATION, generation); generationChecked = true;
    for (const entry of queuedRequests(userId)) {
      if (actor !== userId || session.token !== token) break;
      if (entry.error) continue;
      if (entry.generation !== generation) {
        entry.error = "This request belongs to an earlier database restore. Review the order.";
        localStorage.setItem(PREFIX + entry.id, JSON.stringify(entry)); continue;
      }
      try {
        const result = await apiFetch(entry.path, { method: "POST", body: entry.body });
        // A punch is acknowledged only after the response; never clear newer cart rows.
        if (entry.draftKey) {
          const refs = new Set((JSON.parse(entry.body).items as Array<{ clientRef: string }>).map((item) => item.clientRef));
          const draft = JSON.parse(localStorage.getItem(entry.draftKey) ?? "[]") as Array<{ clientRef: string }>;
          localStorage.setItem(entry.draftKey, JSON.stringify(draft.filter((item) => !refs.has(item.clientRef))));
        }
        localStorage.removeItem(PREFIX + entry.id);
        waiters.get(entry.id)?.resolve(result); waiters.delete(entry.id);
        window.dispatchEvent(new CustomEvent("forkflow:ack", { detail: entry }));
      } catch (error) {
        if (!(error instanceof ApiError) || error.status >= 500 || error.status === 401 || error.status === 429) break;
        entry.error = error.message;
        localStorage.setItem(PREFIX + entry.id, JSON.stringify(entry));
        waiters.get(entry.id)?.reject(error); waiters.delete(entry.id);
      }
      notifyQueue();
    }
  } catch { generationChecked = false; }
  finally { running = false; notifyQueue(); }
}
export function queueConnected() { return generationChecked; }
