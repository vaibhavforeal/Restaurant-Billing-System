import { describe, expect, it } from "vitest";
import { BillCreate, BillPreview, BuyerDetails, CustomerCreate, CustomerUpdate, SettingsUpdate } from "./index.js";

const ACME = "29AABCU9603R1ZJ";

describe("BuyerDetails", () => {
  it("cleans a business buyer's details", () => {
    expect(BuyerDetails.parse({ gstin: ` ${ACME.toLowerCase()} `, name: " Acme Pvt Ltd ", address: " MG Road " }))
      .toEqual({ gstin: ACME, name: "Acme Pvt Ltd", address: "MG Road" });
    expect(BuyerDetails.parse({ gstin: ACME, name: "Acme" }).address).toBe("");
  });
  it("rejects a GSTIN that fails the check character, and a missing name", () => {
    const bad = BuyerDetails.safeParse({ gstin: "29AABCU9603R1ZK", name: "Acme" });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues[0]!.message).toMatch(/check/i);
    expect(BuyerDetails.safeParse({ gstin: ACME, name: " " }).success).toBe(false);
  });
  it("is optional on a bill and defaults to none", () => {
    expect(BillPreview.parse({}).buyer).toBeNull();
    const create = BillCreate.parse({ clientRef: "ref-12345", previewKey: "k", buyer: { gstin: ACME, name: "Acme" } });
    expect(create.buyer).toEqual({ gstin: ACME, name: "Acme", address: "" });
  });
});

describe("customer GSTIN", () => {
  const base = { name: "Acme canteen", phone: "9845012345" };
  it("stores a valid GSTIN with the business legal name", () => {
    expect(CustomerCreate.parse(base)).toMatchObject({ gstin: null, legalName: null });
    expect(CustomerCreate.parse({ ...base, gstin: ACME.toLowerCase(), legalName: "Acme Pvt Ltd" })).toMatchObject({ gstin: ACME, legalName: "Acme Pvt Ltd" });
    expect(CustomerCreate.parse({ ...base, gstin: "", legalName: "" })).toMatchObject({ gstin: null, legalName: null });
  });
  it("needs the legal name with a GSTIN, and a valid GSTIN", () => {
    expect(CustomerCreate.safeParse({ ...base, gstin: ACME }).error!.issues[0]!.path).toEqual(["legalName"]);
    expect(CustomerCreate.safeParse({ ...base, gstin: "29AABCU9603R1ZK", legalName: "Acme" }).success).toBe(false);
    expect(CustomerUpdate.parse({ gstin: "" })).toEqual({ gstin: null });
  });
});

describe("GST return settings", () => {
  const base = { restaurantName: "Cafe" };
  it("accepts a 4 to 8 digit SAC code", () => {
    expect(SettingsUpdate.parse({ ...base, sacCode: " 996331 " }).sacCode).toBe("996331");
    expect(SettingsUpdate.safeParse({ ...base, sacCode: "99633A" }).success).toBe(false);
    expect(SettingsUpdate.safeParse({ ...base, sacCode: "996" }).success).toBe(false);
  });
  it("accepts a blank or valid Zomato GSTIN from the restaurant's state", () => {
    expect(SettingsUpdate.parse({ ...base, zomatoGstin: "" }).zomatoGstin).toBe("");
    expect(SettingsUpdate.parse({ ...base, stateCode: "29", zomatoGstin: ACME.toLowerCase() }).zomatoGstin).toBe(ACME);
    expect(SettingsUpdate.safeParse({ ...base, zomatoGstin: "29AABCU9603R1ZK" }).success).toBe(false);
    expect(SettingsUpdate.safeParse({ ...base, stateCode: "27", zomatoGstin: ACME }).error!.issues[0]!.path).toEqual(["zomatoGstin"]);
  });
});
