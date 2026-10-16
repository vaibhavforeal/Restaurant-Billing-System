import type { FeatureCatalog } from "@forkflow/domain";

type FetchCatalog = (path: string, init?: RequestInit) => Promise<FeatureCatalog>;
export class FeaturesStore {
  snapshot: { catalog: FeatureCatalog | null; ready: boolean; error: string } = { catalog: null, ready: false, error: "" };
  private listeners = new Set<() => void>();
  private reads = 0;
  private disposed = false;
  constructor(private fetchCatalog: FetchCatalog) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  isActive = (id: string): boolean => this.snapshot.catalog?.features.some(feature => feature.id === id && feature.active) === true;
  private publish(catalog: FeatureCatalog | null, error = "") {
    if (this.disposed) return;
    const old = this.snapshot.catalog;
    this.snapshot = { catalog: catalog && (!old || catalog.revision >= old.revision) ? catalog : old, ready: true, error };
    for (const listener of this.listeners) listener();
  }
  async refresh(): Promise<void> {
    const request = ++this.reads;
    try {
      const catalog = await this.fetchCatalog("/api/features", { cache: "no-store" });
      if (request === this.reads) this.publish(catalog);
    } catch (error) {
      if (request === this.reads) this.publish(null, error instanceof Error ? error.message : "Features could not be loaded");
    }
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const catalog = await this.fetchCatalog(`/api/features/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    if (this.disposed) return;
    ++this.reads;
    this.publish(catalog);
  }
  dispose(): void { this.disposed = true; ++this.reads; this.listeners.clear(); }
}
