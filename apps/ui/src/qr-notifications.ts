import type { GuestRequest } from "@forkflow/domain";

/** Keep IDs until expiry so reconnects and repeated snapshots never ring twice. */
export class QrArrivalTracker {
  private seen = new Map<string, number>();
  private initialized = false;

  update(requests: GuestRequest[], now = Date.now()): GuestRequest[] {
    for (const [id, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(id);
    const arrivals = requests.filter((request) => request.expiresAt > now && !this.seen.has(request.id));
    for (const request of requests) this.seen.set(request.id, request.expiresAt);
    const notify = this.initialized ? arrivals : [];
    this.initialized = true;
    return notify;
  }
}

/** Coalesce live events without losing changes that arrive during a read. */
export function startQrMonitor(options: {
  read: (signal: AbortSignal) => Promise<GuestRequest[]>;
  subscribe: (refresh: () => void) => () => void;
  onSnapshot: (requests: GuestRequest[], arrivals: GuestRequest[]) => void;
  onError: () => void;
}) {
  const tracker = new QrArrivalTracker();
  const controller = new AbortController();
  let reading = false;
  let queued = false;
  async function refresh() {
    if (controller.signal.aborted) return;
    if (reading) { queued = true; return; }
    reading = true;
    try {
      const requests = await options.read(AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]));
      if (!controller.signal.aborted) options.onSnapshot(requests, tracker.update(requests));
    } catch {
      if (!controller.signal.aborted) options.onError();
    } finally {
      reading = false;
      if (queued && !controller.signal.aborted) { queued = false; void refresh(); }
    }
  }
  const reload = () => { void refresh(); };
  const unsubscribe = options.subscribe(reload);
  const timer = setInterval(reload, 15_000);
  reload();
  return () => { controller.abort(); clearInterval(timer); unsubscribe(); };
}
