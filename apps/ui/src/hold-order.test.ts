import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComboGroup } from "@masalapos/domain/combos";
import { heldLines, heldTargets, holdControls, holdPrompt, holdRefusal, punchItems, releaseCartHolds, sendableLines, type HoldDraftRow } from "./hold-order";
import { readOrderSettingsCopy, saveOrderSettingsCopy } from "./offline-cache";
import type { OrderItem, Product } from "./types";

const product = (id: string, kotStationId: string | null, combo?: ComboGroup[]): Product => ({
  id, categoryId: "c", name: id, description: "", isSoldOut: false, photoVersion: null, photoUrl: null, pricePaise: 10000, gstRate: null,
  isVeg: true, kotStationId, isActive: true, variants: [], kind: combo ? "combo" : "item", ...(combo ? { combo } : {}),
});
const groups: ComboGroup[] = [{ id: "g1", name: "Included", minPicks: 1, maxPicks: 1, options: [{ id: "o-dal", productId: "dal", variantId: null, name: "dal", qty: 1, extraPricePaise: 0 }] }];
const catalog = [product("dal", "kitchen"), product("naan", "kitchen"), product("water", null), product("thali", null, groups)];
const line = (id: string, productId: string, extra: Partial<OrderItem> = {}): OrderItem => ({
  id, clientRef: `ref-${id}-0000`, productId, variantId: null, name: productId, pricePaise: 0, gstRate: 5, qty: 1, status: "pending", note: null, cancelReason: null, kotId: null, parentItemId: null, held: false, ...extra,
});
const row = (clientRef: string, productId: string, extra: Partial<HoldDraftRow> = {}): HoldDraftRow => ({ clientRef, productId, variantId: null, qty: 1, note: "", ...extra });

describe("hold order helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("punchItems keeps held only when true and drops an empty note", () => {
    expect(punchItems([row("r1", "dal", { held: true, note: "Less oil" }), row("r2", "naan", { held: false }), row("r3", "thali", { comboPicks: ["o-dal"] })])).toEqual([
      { clientRef: "r1", productId: "dal", variantId: null, qty: 1, note: "Less oil", held: true },
      { clientRef: "r2", productId: "naan", variantId: null, qty: 1 },
      { clientRef: "r3", productId: "thali", variantId: null, qty: 1, comboPicks: ["o-dal"] },
    ]);
  });

  it("heldLines and sendableLines split pending kitchen lines by hold", () => {
    const items = [
      line("a", "dal", { held: true }), line("b", "naan"),
      line("t", "thali", { held: true }), line("ta", "dal", { parentItemId: "t" }),
      line("s", "naan", { status: "sent", held: true }),
    ];
    expect(heldLines(items).map((i) => i.id)).toEqual(["a", "t"]);
    expect(sendableLines(items, catalog).map((i) => i.id)).toEqual(["b"]);
  });

  it("heldTargets names held lines and held kitchen cart rows once each", () => {
    const items = [line("a", "dal", { held: true }), line("b", "naan", { held: true, clientRef: null }), line("c", "naan")];
    const cart = [
      row("cart-dal-0001", "dal", { held: true }),
      row("cart-water-01", "water", { held: true }), // stationless: never goes to the kitchen
      row("ref-a-0000", "dal", { held: true }), // already punched as line a
      row("cart-naan-001", "naan"),
    ];
    expect(heldTargets(items, cart, catalog)).toEqual({ itemIds: ["b"], itemRefs: ["ref-a-0000", "cart-dal-0001"], count: 3 });
    expect(heldTargets([], [], catalog)).toEqual({ itemIds: [], itemRefs: [], count: 0 });
  });

  it("holdPrompt counts the dishes", () => {
    expect(holdPrompt(1)).toBe("Send 1 held item to the kitchen and continue?");
    expect(holdPrompt(3)).toBe("Send 3 held items to the kitchen and continue?");
  });

  it("holdControls hides Hold when the setting is off but keeps Fire for held dishes", () => {
    expect(holdControls(false, 2)).toEqual({ showHold: false, showFire: true });
    expect(holdControls(true, 0)).toEqual({ showHold: true, showFire: false });
  });

  it("holdRefusal turns the hub's refusal of a hold into words for staff, and ignores other errors", () => {
    expect(holdRefusal("item is not pending", "Paneer tikka")).toBe("Paneer tikka was already sent to the kitchen");
    expect(holdRefusal("Hold orders is turned off in Settings", "Paneer tikka")).toBe("Hold orders is turned off in Settings");
    expect(holdRefusal("Failed to fetch", "Paneer tikka")).toBeNull();
  });

  it("releaseCartHolds clears holds in the cart when Hold orders is turned off", () => {
    const rows = [row("r1", "dal", { held: true }), row("r2", "naan")];
    const released = releaseCartHolds(rows);
    expect(released.changed).toBe(true);
    expect(released.rows.map((r) => r.held)).toEqual([undefined, undefined]);
    expect(released.rows[0]).toMatchObject({ clientRef: "r1", productId: "dal" });
    expect(releaseCartHolds([row("r2", "naan")]).changed).toBe(false);
  });

  it("keeps the last order settings on the device", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    expect(readOrderSettingsCopy("u1")).toBeNull();
    saveOrderSettingsCopy("u1", { holdOrders: false });
    expect(readOrderSettingsCopy("u1")).toEqual({ holdOrders: false });
    expect(readOrderSettingsCopy("u2")).toBeNull();
  });
});

it("preserves add-on picks in held and offline punches without sending display snapshots", () => {
  expect(punchItems([row("r-addon", "dal", { qty: 2, held: true, addonPicks: ["cheese-option"], addons: [{ productId: "cheese" }] })])).toEqual([
    { clientRef: "r-addon", productId: "dal", variantId: null, qty: 2, held: true, addonPicks: ["cheese-option"] },
  ]);
});
it("holds and fires a dish once even when its add-ons are held too", () => {
  const items = [line("dish", "water", { held: true }), line("addon", "dal", { addonOfItemId: "dish", held: true })];
  expect(heldLines(items).map((item) => item.id)).toEqual(["dish"]);
  expect(heldTargets(items, [], catalog)).toEqual({ itemIds: [], itemRefs: ["ref-dish-0000"], count: 1 });
  expect(sendableLines(items, catalog)).toEqual([]);
});
