import { describe, expect, it } from "vitest";
import type { FeatureCatalog } from "@forkflow/domain";
import { FeaturesStore } from "./features-store";

const catalog = (revision: number, active: boolean): FeatureCatalog => ({ revision, features: [{ id: "inventory", name: "Inventory", description: "", category: "Inventory", configurable: true, defaultEnabled: true, dependencies: [], active, enabled: active, licensed: true, available: true, reason: active ? null : "Turned off", updatedAt: null }] });
const deferred = () => { let resolve!: (value: FeatureCatalog) => void; const promise = new Promise<FeatureCatalog>(done => { resolve = done; }); return { promise, resolve }; };

describe("shared feature availability", () => {
  it("fails closed until loaded and keeps known state when reconnect fails", async () => {
    let fail = false;
    const store = new FeaturesStore(async () => { if (fail) throw new Error("offline"); return catalog(0, true); });
    expect(store.isActive("inventory")).toBe(false);
    await store.refresh();
    expect(store.isActive("inventory")).toBe(true);
    fail = true; await store.refresh();
    expect(store.isActive("inventory")).toBe(true);
    expect(store.snapshot.error).toContain("offline");
  });
  it("does not let a stale fetch overwrite a saved toggle", async () => {
    const pending = deferred();
    const store = new FeaturesStore(async (_path, init) => init?.method === "PATCH" ? catalog(2, false) : pending.promise);
    const loading = store.refresh();
    await store.setEnabled("inventory", false);
    pending.resolve(catalog(1, true)); await loading;
    expect(store.isActive("inventory")).toBe(false);
    expect(store.snapshot.catalog?.revision).toBe(2);
  });
  it("retains the newest catalog when two writes finish in reverse order", async () => {
    const first = deferred(), second = deferred(); let calls = 0;
    const store = new FeaturesStore(async () => ++calls === 1 ? first.promise : second.promise);
    const a = store.setEnabled("inventory", true), b = store.setEnabled("inventory", false);
    second.resolve(catalog(3, false)); await b;
    first.resolve(catalog(2, true)); await a;
    expect(store.isActive("inventory")).toBe(false);
  });
  it("notifies subscribers and accepts same-revision licence changes", async () => {
    let active = true, notifications = 0;
    const store = new FeaturesStore(async () => catalog(1, active));
    const stop = store.subscribe(() => notifications++);
    await store.refresh(); active = false; await store.refresh();
    expect(store.isActive("inventory")).toBe(false);
    expect(notifications).toBeGreaterThan(1);
    stop(); const before = notifications; await store.refresh(); expect(notifications).toBe(before);
  });
  it("ignores old-session reads and write responses after disposal", async () => {
    const pending = deferred(); const store = new FeaturesStore(async () => pending.promise);
    const read = store.refresh(); const write = store.setEnabled("inventory", true);
    store.dispose(); pending.resolve(catalog(1, true)); await Promise.all([read, write]);
    expect(store.isActive("inventory")).toBe(false);
  });
  it("leaves state unchanged and exposes write errors", async () => {
    const store = new FeaturesStore(async (_path, init) => { if (init?.method === "PATCH") throw new Error("Requires Pro"); return catalog(0, false); });
    await store.refresh();
    await expect(store.setEnabled("inventory", true)).rejects.toThrow("Requires Pro");
    expect(store.isActive("inventory")).toBe(false);
  });
});
