import { describe, expect, it } from "vitest";
import { ProductCreate, ProductUpdate, SettingsUpdate } from "./index.js";

describe("GST settings and catalog schemas", () => {
  const base = { restaurantName: "Cafe" };

  it("accepts the two modes and the three default rates only", () => {
    expect(SettingsUpdate.parse({ ...base, gstMode: "none", gstRate: 12 })).toMatchObject({ gstMode: "none", gstRate: 12 });
    expect(SettingsUpdate.safeParse({ ...base, gstMode: "exclusive" }).success).toBe(false);
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
