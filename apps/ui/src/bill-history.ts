import type { Bill } from "@forkflow/domain";

export type BillHistoryStatus = "unpaid" | "paid" | "all";
export type BillPageFetcher = (status: BillHistoryStatus, before?: number, signal?: AbortSignal) => Promise<Bill[]>;

export interface BillHistorySnapshot {
  status: BillHistoryStatus;
  bills: Bill[];
  busy: boolean;
  more: boolean;
  error: string;
}

const pageSize = 100;
const failureMessage = (reason: unknown) => reason instanceof Error ? reason.message : "Failed to load bills";

function uniqueById(bills: Bill[]): Bill[] {
  const seen = new Set<string>();
  return bills.filter(bill => !seen.has(bill.id) && !!seen.add(bill.id)).sort((a, b) => b.billNo - a.billNo);
}

/** Owns the paged bill list, refresh boundary and serialized API requests used by the history screen. */
export class BillHistory {
  private boundary: number | null = null;
  private lookahead: Bill[] = [];
  private lookaheadHasMore = false;
  private revision = 0;
  private controller: AbortController | null = null;
  private refreshTask: Promise<void> | null = null;
  private loadTask: Promise<void> | null = null;
  private refreshQueued = false;
  private disposed = false;
  private listeners = new Set<(snapshot: BillHistorySnapshot) => void>();
  private snapshot: BillHistorySnapshot;

  constructor(private readonly fetchPage: BillPageFetcher, status: BillHistoryStatus = "unpaid") {
    this.snapshot = { status, bills: [], busy: false, more: false, error: "" };
  }

  getSnapshot = (): BillHistorySnapshot => this.snapshot;

  subscribe = (listener: (snapshot: BillHistorySnapshot) => void): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setStatus(status: BillHistoryStatus): void {
    if (this.disposed || status === this.snapshot.status) return;
    this.revision++;
    this.controller?.abort();
    this.controller = null;
    this.refreshTask = null;
    this.loadTask = null;
    this.refreshQueued = false;
    this.boundary = null;
    this.lookahead = [];
    this.lookaheadHasMore = false;
    this.publish({ status, bills: [], busy: false, more: false, error: "" });
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.refreshTask) { this.refreshQueued = true; return this.refreshTask; }
    if (this.loadTask) { this.refreshQueued = true; return this.loadTask; }

    const revision = ++this.revision;
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ busy: true });
    let task!: Promise<void>;
    task = this.refreshRows(revision, controller).finally(() => {
      if (this.refreshTask === task) this.refreshTask = null;
      if (this.controller === controller) this.controller = null;
      if (this.refreshQueued && !this.disposed) {
        this.refreshQueued = false;
        void this.refresh();
      }
    });
    this.refreshTask = task;
    return task;
  }

  loadOlder(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.loadTask) return this.loadTask;
    if (this.refreshTask) {
      const controller = this.controller;
      return this.refreshTask.then(() => controller?.signal.aborted ? undefined : this.loadOlder());
    }
    if (!this.snapshot.more || this.boundary === null) return Promise.resolve();

    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ busy: true });
    let task!: Promise<void>;
    task = this.extendRows(revision, controller).finally(async () => {
      if (this.loadTask === task) this.loadTask = null;
      if (this.controller === controller) this.controller = null;
      if (this.refreshQueued && !this.disposed) {
        this.refreshQueued = false;
        await this.refresh();
      }
    });
    this.loadTask = task;
    return task;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.controller?.abort();
    this.controller = null;
    this.refreshTask = null;
    this.loadTask = null;
    this.refreshQueued = false;
    this.listeners.clear();
  }

  private async readPage(status: BillHistoryStatus, before: number | undefined, signal: AbortSignal): Promise<Bill[]> {
    const page = await this.fetchPage(status, before, signal);
    return [...page].sort((a, b) => b.billNo - a.billNo);
  }

  private async refreshRows(revision: number, controller: AbortController): Promise<void> {
    const status = this.snapshot.status;
    const boundary = this.boundary;
    try {
      if (boundary === null) {
        const first = uniqueById(await this.readPage(status, undefined, controller.signal));
        if (!this.isCurrent(revision, controller)) return;
        const nextBoundary = first.length ? first[first.length - 1]!.billNo : null;
        let lookahead: Bill[] = [];
        let lookaheadHasMore = false;
        if (first.length === pageSize && nextBoundary !== null) {
          lookahead = uniqueById(await this.readPage(status, nextBoundary, controller.signal));
          lookaheadHasMore = lookahead.length === pageSize;
        }
        if (!this.isCurrent(revision, controller)) return;
        this.boundary = nextBoundary;
        this.lookahead = lookahead;
        this.lookaheadHasMore = lookaheadHasMore;
        this.publish({ bills: first, more: lookahead.length > 0, error: "", busy: false });
        return;
      }

      const collected: Bill[] = [];
      let before: number | undefined;
      let lookahead: Bill[] = [];
      let lookaheadHasMore = false;
      let more = false;
      let ended = false;
      while (!ended) {
        const page = await this.readPage(status, before, controller.signal);
        if (!this.isCurrent(revision, controller)) return;
        if (!page.length) break;
        collected.push(...page);
        const oldest = page[page.length - 1]!.billNo;
        if (oldest <= boundary) {
          const belowBoundary = uniqueById(page.filter(bill => bill.billNo < boundary));
          if (belowBoundary.length) {
            lookahead = belowBoundary;
            lookaheadHasMore = page.length === pageSize;
            more = true;
          } else if (page.length === pageSize && oldest === boundary) {
            lookahead = uniqueById(await this.readPage(status, boundary, controller.signal));
            if (!this.isCurrent(revision, controller)) return;
            lookaheadHasMore = lookahead.length === pageSize;
            more = lookahead.length > 0;
          }
          ended = true;
        } else if (page.length < pageSize) {
          ended = true;
        } else {
          before = oldest;
        }
      }
      if (!this.isCurrent(revision, controller)) return;
      this.lookahead = lookahead;
      this.lookaheadHasMore = lookaheadHasMore;
      this.publish({ bills: uniqueById(collected.filter(bill => bill.billNo >= boundary)), more, error: "", busy: false });
    } catch (reason) {
      if (this.isCurrent(revision, controller)) this.publish({ error: failureMessage(reason), busy: false });
    }
  }

  private async extendRows(revision: number, controller: AbortController): Promise<void> {
    const status = this.snapshot.status;
    const oldBoundary = this.boundary;
    if (oldBoundary === null) { this.publish({ busy: false }); return; }
    try {
      const page = this.lookahead.length
        ? this.lookahead
        : uniqueById(await this.readPage(status, oldBoundary, controller.signal));
      if (!this.isCurrent(revision, controller)) return;
      if (!page.length) {
        this.lookahead = [];
        this.lookaheadHasMore = false;
        this.publish({ more: false, error: "", busy: false });
        return;
      }
      const newBoundary = Math.min(oldBoundary, ...page.map(bill => bill.billNo));
      let nextLookahead: Bill[] = [];
      let nextLookaheadHasMore = false;
      if (this.lookaheadHasMore && page.length < pageSize) {
        nextLookahead = uniqueById(await this.readPage(status, newBoundary, controller.signal));
        if (!this.isCurrent(revision, controller)) return;
        nextLookaheadHasMore = nextLookahead.length === pageSize;
      } else if (page.length === pageSize) {
        nextLookahead = uniqueById(await this.readPage(status, newBoundary, controller.signal));
        if (!this.isCurrent(revision, controller)) return;
        nextLookaheadHasMore = nextLookahead.length === pageSize;
      }
      if (!this.isCurrent(revision, controller)) return;
      this.boundary = newBoundary;
      this.lookahead = nextLookahead;
      this.lookaheadHasMore = nextLookaheadHasMore;
      this.publish({
        bills: uniqueById([...this.snapshot.bills, ...page]), more: nextLookahead.length > 0, error: "", busy: false,
      });
    } catch (reason) {
      if (this.isCurrent(revision, controller)) this.publish({ error: failureMessage(reason), busy: false });
    }
  }

  private isCurrent(revision: number, controller: AbortController): boolean {
    return !this.disposed && !controller.signal.aborted && revision === this.revision;
  }

  private publish(changes: Partial<BillHistorySnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
