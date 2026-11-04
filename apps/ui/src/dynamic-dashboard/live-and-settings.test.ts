import { describe, expect, it } from "vitest";
import { DASHBOARD_LIVE_EVENTS } from "./useDashboardData";
import { topNChoices } from "./WidgetSettings";

describe("dashboard live events", () => {
  it("covers orders, kitchen tickets, QR requests, stock and tables", () => {
    expect([...DASHBOARD_LIVE_EVENTS].sort()).toEqual(
      ["guest-request.changed", "kot.created", "kot.updated", "order.updated", "stock.changed", "table.changed"],
    );
  });
});

describe("top-N choices", () => {
  it("offers the fixed list", () => {
    expect(topNChoices(10)).toEqual([3, 5, 10, 15, 20]);
  });
  it("keeps a stored value that is not in the list", () => {
    expect(topNChoices(7)).toEqual([3, 5, 7, 10, 15, 20]);
  });
});
