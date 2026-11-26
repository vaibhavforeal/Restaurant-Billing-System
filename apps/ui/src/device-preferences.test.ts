import { beforeEach, describe, expect, it } from "vitest";
import { PAYMENT_LAST_KEY, PAYMENT_START_KEY, allowedPayment, readPaymentStart, rememberPayment, savePaymentStart, startingPayment } from "./device-preferences";

describe("starting payment method", () => {
  it("uses the last method used when the device follows the last one", () => {
    expect(startingPayment("last", "upi")).toBe("upi");
    expect(startingPayment("last", "card")).toBe("card");
  });

  it("falls back to cash when nothing usable was saved", () => {
    expect(startingPayment("last", "")).toBe("cash");
    expect(startingPayment("last", "cheque")).toBe("cash");
  });

  it("always starts on the chosen method when one is set", () => {
    expect(startingPayment("card", "upi")).toBe("card");
    expect(startingPayment("cash", "upi")).toBe("cash");
  });
});

describe("payment preferences in storage", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    } });
  });

  it("follows the last method by default and keeps the device's choice", () => {
    expect(readPaymentStart()).toBe("last");
    savePaymentStart("upi");
    expect(store.get(PAYMENT_START_KEY)).toBe("upi");
    expect(readPaymentStart()).toBe("upi");
  });

  it("treats an unknown saved choice as following the last method", () => {
    store.set(PAYMENT_START_KEY, "wallet");
    expect(readPaymentStart()).toBe("last");
  });

  it("remembers the method used on a bill under the existing key", () => {
    rememberPayment("card");
    expect(store.get(PAYMENT_LAST_KEY)).toBe("card");
    expect(PAYMENT_LAST_KEY).toBe("masalapos.payment-mode");
  });
});

describe("payment methods the counter takes", () => {
  it("keeps the preferred method while it is on", () => {
    expect(allowedPayment("upi", ["cash", "card", "upi"])).toBe("upi");
  });
  it("falls back to the first method still on", () => {
    expect(allowedPayment("cash", ["card", "upi"])).toBe("card");
    expect(allowedPayment("card", ["upi"])).toBe("upi");
  });
  it("keeps the preferred method when the list has not loaded", () => {
    expect(allowedPayment("card", [])).toBe("card");
  });
});
