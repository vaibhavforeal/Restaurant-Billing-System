import { describe, expect, it } from "vitest";
import { chargeInputNote, keepChargeDraft, percentToBp, rupeesToChargePaise, showServiceChargeBox } from "./charges-form";

describe("charge settings conversions", () => {
  it("turns a percent into basis points, rounded and clamped to 0-20%", () => {
    expect(percentToBp("12.5")).toBe(1250);
    expect(percentToBp("0.07")).toBe(7);
    expect(percentToBp("25")).toBe(2000);
    expect(percentToBp("")).toBe(0);
    expect(percentToBp("abc")).toBe(0);
    expect(percentToBp("-1")).toBe(0);
  });
  it("turns rupees into paise, clamped to 0-1000 rupees", () => {
    expect(rupeesToChargePaise("20")).toBe(2000);
    expect(rupeesToChargePaise("1500")).toBe(100000);
    expect(rupeesToChargePaise("")).toBe(0);
    expect(rupeesToChargePaise("-5")).toBe(0);
  });
});

describe("showServiceChargeBox", () => {
  const base = { billed: false, open: true, orderType: "dine_in", serviceDue: true, serviceCharge: true };
  it("shows for an open dine-in order once a service charge was previewed", () => expect(showServiceChargeBox(base)).toBe(true));
  it("stays shown after the preview is cleared by re-ticking", () => expect(showServiceChargeBox({ ...base, serviceCharge: true })).toBe(true));
  it("shows while unticked even if never previewed", () => expect(showServiceChargeBox({ ...base, serviceDue: false, serviceCharge: false })).toBe(true));
  it("is hidden when there is no service charge", () => expect(showServiceChargeBox({ ...base, serviceDue: false })).toBe(false));
  it("is hidden for parcel, Zomato and billed orders", () => {
    expect(showServiceChargeBox({ ...base, orderType: "parcel" })).toBe(false);
    expect(showServiceChargeBox({ ...base, orderType: "zomato" })).toBe(false);
    expect(showServiceChargeBox({ ...base, billed: true })).toBe(false);
  });
});

describe("chargeInputNote", () => {
  it("says nothing for a value inside the range or a blank box", () => {
    expect(chargeInputNote("12.5", 20, "%")).toBeNull();
    expect(chargeInputNote("", 20, "%")).toBeNull();
    expect(chargeInputNote("1000", 1000, "₹")).toBeNull();
  });
  it("says what will be saved when the value is above the most allowed", () => {
    expect(chargeInputNote("25", 20, "%")).toBe("The most is 20%; 20% will be saved.");
    expect(chargeInputNote("1500", 1000, "₹")).toBe("The most is ₹1000; ₹1000 will be saved.");
  });
  it("says 0 will be saved for a negative value", () => {
    expect(chargeInputNote("-2", 20, "%")).toBe("Can't be below 0; 0 will be saved.");
  });
});

describe("keepChargeDraft", () => {
  it("keeps what was typed while it still means the saved value", () => {
    expect(keepChargeDraft("", 0, percentToBp)).toBe(true);
    expect(keepChargeDraft("2.", 200, percentToBp)).toBe(true);
    expect(keepChargeDraft("12.50", 1250, percentToBp)).toBe(true);
  });
  it("drops the draft when the saved value changed from elsewhere", () => {
    expect(keepChargeDraft("5", 1000, percentToBp)).toBe(false);
    expect(keepChargeDraft("", 2000, rupeesToChargePaise)).toBe(false);
  });
});
