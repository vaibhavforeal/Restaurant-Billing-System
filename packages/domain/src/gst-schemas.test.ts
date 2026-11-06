import { describe, expect, it } from "vitest";
import { ProductCreate, ProductUpdate, SettingsUpdate } from "./index.js";

describe("GST settings and catalog schemas", () => {
  const base = { restaurantName: "Cafe" };

  it("accepts the three modes and the three default rates only", () => {
    expect(SettingsUpdate.parse({ ...base, gstMode: "none", gstRate: 12 })).toMatchObject({ gstMode: "none", gstRate: 12 });
    expect(SettingsUpdate.parse({ ...base, gstMode: "exclusive" }).gstMode).toBe("exclusive");
    expect(SettingsUpdate.safeParse({ ...base, gstMode: "inclusive" }).success).toBe(false);
    expect(SettingsUpdate.safeParse({ ...base, gstRate: 28 }).success).toBe(false);
    expect(SettingsUpdate.safeParse({ ...base, gstRate: 0 }).success).toBe(false);
  });

  it("lets a product follow the restaurant default rate with null", () => {
    const create = { categoryId: "c", name: "Dosa", pricePaise: 10000 };
    expect(ProductCreate.parse(create).gstRate).toBeNull();
    expect(ProductCreate.parse({ ...create, gstRate: 0 }).gstRate).toBe(0);
    expect(ProductCreate.safeParse({ ...create, gstRate: 7 }).success).toBe(false);
    expect(ProductUpdate.parse({ gstRate: null }).gstRate).toBeNull();
  });
});

describe("bill charge settings", () => {
  const base = { restaurantName: "Cafe" };
  it("bounds the service percentage, packaging amount and labels", () => {
    expect(SettingsUpdate.parse({ ...base, serviceChargeBp: 2000 }).serviceChargeBp).toBe(2000);
    expect(SettingsUpdate.safeParse({ ...base, serviceChargeBp: 2001 }).success).toBe(false);
    expect(SettingsUpdate.safeParse({ ...base, serviceChargeBp: 12.5 }).success).toBe(false);
    expect(SettingsUpdate.parse({ ...base, packagingChargePaise: 100000 }).packagingChargePaise).toBe(100000);
    expect(SettingsUpdate.safeParse({ ...base, packagingChargePaise: 100001 }).success).toBe(false);
    expect(SettingsUpdate.safeParse({ ...base, serviceChargeLabel: "x".repeat(25) }).success).toBe(false);
    expect(SettingsUpdate.parse({ ...base, packagingChargeLabel: "  Box  " }).packagingChargeLabel).toBe("Box");
  });
});
