import { describe, expect, it } from "vitest";
import { bindOutletStorage, OUTLET_BINDING_KEY, scopedStorage, verifyOutletHealth } from "./outlet-identity";

function storage() {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear() };
}
describe("outlet browser storage identity", () => {
  it("archives legacy sessions and drafts without replaying them into a newly identified outlet", () => {
    const source = storage(); source.setItem("forkflow.token", "old-token"); source.setItem("forkflow.draft.cashier.order", "old-draft"); source.setItem("unrelated", "keep");
    const binding = bindOutletStorage(source, { outletIdentity: "outlet-a", generation: "initial" }), scoped = scopedStorage(source, binding);
    expect(scoped.getItem("forkflow.token")).toBeNull();
    expect(scoped.getItem("forkflow.draft.cashier.order")).toBeNull();
    expect(source.getItem("forkflow.draft.cashier.order")).toBe("old-draft");
    expect(source.getItem(binding.archiveKey!)).toContain("old-draft");
    expect(source.getItem("unrelated")).toBe("keep");
  });
  it("shares state between windows only for the same outlet and recovery generation", () => {
    const source = storage(), first = bindOutletStorage(source, { outletIdentity: "outlet-a", generation: "initial" });
    const a = scopedStorage(source, first); a.setItem("forkflow.token", "a-token"); a.setItem("forkflow.queue.v1.request", "a-request");
    const sibling = scopedStorage(source, bindOutletStorage(source, { outletIdentity: "outlet-a", generation: "initial" }));
    expect(sibling.getItem("forkflow.token")).toBe("a-token");
    expect(sibling.key(0)).toBe("forkflow.token");
    const second = bindOutletStorage(source, { outletIdentity: "outlet-b", generation: "initial" }), b = scopedStorage(source, second);
    expect(b.getItem("forkflow.token")).toBeNull(); expect(b.length).toBe(0);
    expect(source.getItem(second.archiveKey!)).toContain("a-request");
    expect(() => a.setItem("forkflow.queue.v1.wrong", "wrong-outlet")).toThrow(/changed/);
  });
  it("starts a clean scope after restore even if user and order identifiers repeat", () => {
    const source = storage(), initial = bindOutletStorage(source, { outletIdentity: "outlet-a", generation: "initial" });
    scopedStorage(source, initial).setItem("forkflow.draft.same-user.same-order", "before-restore");
    const restored = bindOutletStorage(source, { outletIdentity: "outlet-a", generation: "restore-1" });
    expect(scopedStorage(source, restored).getItem("forkflow.draft.same-user.same-order")).toBeNull();
    expect(source.getItem(restored.archiveKey!)).toContain("before-restore");
  });
  it("does not switch identity when recovery archival cannot be verified", () => {
    const source = storage(), initial = bindOutletStorage(source, { outletIdentity: "outlet-a", generation: "initial" });
    scopedStorage(source, initial).setItem("forkflow.queue.v1.pending", "evidence");
    const original = source.setItem; source.setItem = (key, value) => { if (key.startsWith("forkflow.outlet-archive.")) throw new Error("quota"); original(key, value); };
    expect(() => bindOutletStorage(source, { outletIdentity: "outlet-b", generation: "initial" })).toThrow();
    expect(JSON.parse(source.getItem(OUTLET_BINDING_KEY)!).prefix).toBe(initial.prefix);
    expect(scopedStorage(source, initial).getItem("forkflow.queue.v1.pending")).toBe("evidence");
  });
  it("permits legacy fixtures only before a real outlet binding exists", () => {
    const source = storage();
    expect(verifyOutletHealth({ ok: true }, source)).toBeNull();
    expect(verifyOutletHealth({ outletIdentity: "outlet-a", generation: "initial" }, source)).toEqual({ outletIdentity: "outlet-a", generation: "initial" });
    bindOutletStorage(source, { outletIdentity: "outlet-a", generation: "initial" });
    expect(() => verifyOutletHealth({ ok: true }, source)).toThrow(/identity/);
    expect(() => verifyOutletHealth({ outletIdentity: "outlet-a" }, source)).toThrow(/generation/);
  });
});
