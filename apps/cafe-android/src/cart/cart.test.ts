import { describe, expect, it } from "vitest";
import { calculateBill } from "@masalapos/domain/billing";
import { menuCafe } from "../../../../packages/cafe-data/src/testing/fixtures";
import { createCartStore } from "./cart-store";
import { cartTotals } from "./cart";

describe("cartTotals", () => {
  it("prices the snapshot it is given, so a screen recomputes when the snapshot changes", () => {
    const { db, samosa } = menuCafe();
    const store = createCartStore();
    expect(cartTotals(db, store.snapshot())).toBeNull();
    store.add({ itemId: samosa.id, variantId: null, name: "Samosa", pricePaise: 1800, gstRate: 5 });
    store.add({ itemId: samosa.id, variantId: null, name: "Samosa", pricePaise: 1800, gstRate: 5 });
    store.setDiscount({ kind: "percent", bp: 1000 });
    expect(cartTotals(db, store.snapshot())).toMatchObject({ ok: true, discountPaise: 360, totals: { totalPaise: calculateBill([{ pricePaise: 1800, qty: 2, gstRate: 5 }], 360, "included", "rupee").totalPaise } });
  });
});
