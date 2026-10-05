import { describe, expect, it } from "vitest";
import { kitchenBillingBlockReason } from "./kitchen-billing";

const kot = (id: string, kotNo: number, acceptedAt: number | null = null, doneAt: number | null = null) => ({ id, kotNo, acceptedAt, doneAt });
const sent = (kotId: string | null) => ({ status: "sent" as const, kotId });

describe("table billing kitchen acceptance", () => {
  it("blocks a sent table order until its kitchen ticket is accepted", () => {
    const order = { type: "dine_in" as const, items: [sent("kot-a")], kots: [kot("kot-a", 12)] };
    expect(kitchenBillingBlockReason(order)).toBe("Waiting for kitchen to accept KOT #12 before billing this table.");
    expect(kitchenBillingBlockReason({ ...order, kots: [kot("kot-a", 12, 100)] })).toBeNull();
  });

  it("requires acceptance of every active ticket, including a later send", () => {
    const order = { type: "dine_in" as const, items: [sent("kot-a"), sent("kot-b"), sent("kot-b")], kots: [kot("kot-a", 12, 100), kot("kot-b", 13)] };
    expect(kitchenBillingBlockReason({ ...order, kots: [kot("kot-a", 12), kot("kot-b", 13)] })).toBe("Waiting for kitchen to accept KOT #12, #13 before billing this table.");
    expect(kitchenBillingBlockReason(order)).toBe("Waiting for kitchen to accept KOT #13 before billing this table.");
    expect(kitchenBillingBlockReason({ ...order, kots: [kot("kot-a", 12, 100), kot("kot-b", 13, 200)] })).toBeNull();
  });

  it("does not block when the restaurant turned kitchen acceptance off", () => {
    const order = { type: "dine_in" as const, items: [sent("kot-a")], kots: [kot("kot-a", 12)] };
    expect(kitchenBillingBlockReason({ ...order, kitchenAcceptanceRequired: false })).toBeNull();
    expect(kitchenBillingBlockReason({ ...order, kitchenAcceptanceRequired: true })).not.toBeNull();
  });

  it("exempts takeaways, stationless items, and tickets with only cancelled items", () => {
    expect(kitchenBillingBlockReason({ type: "parcel", items: [sent("kot-a")], kots: [kot("kot-a", 12)] })).toBeNull();
    expect(kitchenBillingBlockReason({ type: "dine_in", items: [sent(null), { status: "pending", kotId: null }, { status: "cancelled", kotId: "kot-a" }], kots: [kot("kot-a", 12)] })).toBeNull();
  });

  it("allows completed tickets from older installations and fails closed for a missing ticket", () => {
    expect(kitchenBillingBlockReason({ type: "dine_in", items: [sent("kot-a")], kots: [{ id: "kot-a", kotNo: 12, doneAt: 100 }] })).toBeNull();
    expect(kitchenBillingBlockReason({ type: "dine_in", items: [sent("missing")], kots: [] })).toBe("Waiting for kitchen to accept the kitchen tickets before billing this table.");
  });
});
