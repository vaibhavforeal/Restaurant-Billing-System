import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS, openDb, type Database } from "./index.js";
import { orderItemPackaging } from "./packaging.js";

let db: Database;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Admin', 'x', 'admin', 0)").run();
  db.prepare("INSERT INTO categories (id, name) VALUES ('c', 'Mains')").run();
  db.prepare("INSERT INTO products (id, category_id, name, price_paise, created_at, packaging_paise) VALUES ('biryani', 'c', 'Biryani', 20000, 0, 1000)").run();
  db.prepare("INSERT INTO products (id, category_id, name, price_paise, created_at, packaging_paise, kind) VALUES ('meal', 'c', 'Meal', 30000, 0, 1500, 'combo')").run();
  db.prepare("INSERT INTO variants (id, product_id, name, price_paise, packaging_paise) VALUES ('full', 'biryani', 'Full', 30000, 500)").run();
  db.prepare("INSERT INTO variants (id, product_id, name, price_paise, packaging_paise) VALUES ('half', 'biryani', 'Half', 15000, NULL)").run();
  db.prepare("INSERT INTO variants (id, product_id, name, price_paise, packaging_paise) VALUES ('mini', 'biryani', 'Mini', 9000, 0)").run();
  db.prepare("UPDATE settings SET packaging_per_item = 1 WHERE id = 1").run();
  db.prepare("INSERT INTO order_types (id, name, kind, created_at) VALUES ('delivery', 'Delivery', 'delivery', 0)").run();
});
afterEach(() => db.close());

function order(type: "parcel" | "dine_in" | "zomato", orderTypeId: string | null = null): string {
  const id = `o-${type}-${orderTypeId ?? ""}`;
  db.prepare("INSERT INTO orders (id, client_ref, type, status, opened_by, opened_at, order_type_id, zomato_order_id) VALUES (?, ?, ?, 'open', 'u', 0, ?, ?)")
    .run(id, id, type, orderTypeId, type === "zomato" ? "Z1" : null);
  return id;
}
function item(orderId: string, id: string, productId: string, qty: number, opts: { variantId?: string; parentId?: string; status?: string } = {}) {
  db.prepare("INSERT INTO order_items (id, order_id, product_id, variant_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, status, parent_item_id) VALUES (?, ?, ?, ?, ?, 0, 5, ?, ?, ?)")
    .run(id, orderId, productId, opts.variantId ?? null, id, qty, opts.status ?? "sent", opts.parentId ?? null);
}

describe("orderItemPackaging", () => {
  it("sums unit amount times qty", () => {
    const o = order("parcel");
    item(o, "a", "biryani", 3);
    expect(orderItemPackaging(db, o)).toEqual(new Map([["a", 3000]]));
  });

  it("variant overrides product, blank falls back, zero is free", () => {
    const o = order("parcel");
    item(o, "full", "biryani", 1, { variantId: "full" });
    item(o, "half", "biryani", 1, { variantId: "half" });
    item(o, "mini", "biryani", 1, { variantId: "mini" });
    expect(orderItemPackaging(db, o)).toEqual(new Map([["full", 500], ["half", 1000], ["mini", 0]]));
  });

  it("combo children add nothing", () => {
    const o = order("parcel");
    item(o, "combo", "meal", 1);
    item(o, "child1", "biryani", 1, { parentId: "combo" });
    item(o, "child2", "biryani", 1, { parentId: "combo" });
    expect(orderItemPackaging(db, o)).toEqual(new Map([["combo", 1500]]));
  });

  it("counts delivery parcels", () => {
    const o = order("parcel", "delivery");
    item(o, "a", "biryani", 2);
    expect(orderItemPackaging(db, o)).toEqual(new Map([["a", 2000]]));
  });

  it("toggle off → empty map", () => {
    db.prepare("UPDATE settings SET packaging_per_item = 0 WHERE id = 1").run();
    const o = order("parcel");
    item(o, "a", "biryani", 2);
    expect(orderItemPackaging(db, o).size).toBe(0);
  });

  it("dine-in and Zomato orders → empty map", () => {
    const dineIn = order("dine_in");
    item(dineIn, "a", "biryani", 2);
    expect(orderItemPackaging(db, dineIn).size).toBe(0);
    const zomato = order("zomato");
    item(zomato, "b", "biryani", 2);
    expect(orderItemPackaging(db, zomato).size).toBe(0);
  });

  it("cancelled items are skipped", () => {
    const o = order("parcel");
    item(o, "a", "biryani", 2);
    item(o, "b", "biryani", 1, { status: "cancelled" });
    expect(orderItemPackaging(db, o)).toEqual(new Map([["a", 2000]]));
  });
});
