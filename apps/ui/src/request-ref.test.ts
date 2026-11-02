import { describe, expect, it } from "vitest";
import { refFor, type RequestRef } from "./request-ref";

describe("refFor", () => {
  it("reuses the reference for an unchanged form and issues a new one when it changes", () => {
    const slot: { current: RequestRef } = { current: null };
    const first = refFor(slot, { kind: "pay_out", amountPaise: 50000, reason: "Milk" });
    expect(refFor(slot, { kind: "pay_out", amountPaise: 50000, reason: "Milk" })).toBe(first);
    expect(refFor(slot, { kind: "pay_out", amountPaise: 60000, reason: "Milk" })).not.toBe(first);
  });

  it("issues a new reference once the slot is cleared after success", () => {
    const slot: { current: RequestRef } = { current: null };
    const first = refFor(slot, { points: 100 });
    slot.current = null;
    expect(refFor(slot, { points: 100 })).not.toBe(first);
  });
});
