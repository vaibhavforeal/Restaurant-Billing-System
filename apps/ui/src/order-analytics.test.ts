import { describe, expect, it } from "vitest";
import type { OrderAnalyticsReport } from "@forkflow/domain/operational-reports";
import { analyticsCsv, averageOrder, orderShare, rankedItems } from "./order-analytics";

const report: OrderAnalyticsReport = {
  from: "2026-09-27", to: "2026-09-29", today: "2026-09-29", timezone: "Asia/Kolkata", generatedAt: 1790670000000, orderType: "parcel",
  totals: { orderCount: 1, qty: 5, totalPaise: 10001 },
  comparison: [{ type: "parcel", orderCount: 1, qty: 5, totalPaise: 10001 }, { type: "dine_in", orderCount: 2, qty: 3, totalPaise: 22000 }],
  items: [{ productId: "a", variantId: null, categoryId: "meals", name: '=HYPERLINK("bad")', category: "+Meals", qty: 4, takeawayQty: 4, tableQty: 0, orderCount: 1, totalPaise: 4001 },
    { productId: "b", variantId: null, categoryId: "drinks", name: "Juice", category: "Drinks", qty: 1, takeawayQty: 1, tableQty: 0, orderCount: 1, totalPaise: 6000 }],
  categories: [{ categoryId: "meals", name: "+Meals", qty: 4, orderCount: 1, totalPaise: 4001 }, { categoryId: "drinks", name: "Drinks", qty: 1, orderCount: 1, totalPaise: 6000 }],
  daily: [{ date: "2026-09-27", takeawayOrders: 1, tableOrders: 0, totalPaise: 10001 }], hourly: [{ hour: 12, orderCount: 1, totalPaise: 10001 }],
};

describe("order analytics display and export", () => {
  it("changes ranking without mutating the loaded snapshot", () => {
    expect(rankedItems(report, "quantity")[0]!.qty).toBe(4);
    expect(rankedItems(report, "sales")[0]!.name).toBe("Juice");
    expect(report.items[0]!.qty).toBe(4);
    expect(averageOrder(10001, 2)).toBe(5001); expect(averageOrder(0, 0)).toBe(0);
    expect(orderShare(1, 0)).toBe(0); expect(orderShare(1, 4)).toBe(25);
  });
  it("exports the filtered snapshot, full comparison and safe text with exact rupee amounts", () => {
    const csv = analyticsCsv(report, "sales");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    for (const text of ["Breakdown filter: Quick takeaway", "Order comparison (all order types)", "Highest moving items (ranked by sales)", "Category performance", "Daily order trend", "Busy hours", '"100.01"', '"220.00"', '"12:00"', '"33.3"']) expect(csv).toContain(text);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"'); expect(csv).toContain('"\'+Meals"');
    expect(csv.indexOf('"Juice"')).toBeLessThan(csv.indexOf('"\'=HYPERLINK'));
  });
});
