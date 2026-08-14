import { describe, expect, it } from "vitest";
import {
  CategoryCreate, CategoryUpdate,
  ProductCreate, ProductUpdate, VariantCreate,
  UserCreate, UserUpdate, SettingsUpdate,
} from "./index.js";

describe("catalog schemas", () => {
  it("CategoryCreate defaults sortOrder to 0 and trims the name", () => {
    expect(CategoryCreate.parse({ name: "  Starters " })).toEqual({ name: "Starters", sortOrder: 0 });
  });

  it("CategoryCreate rejects an empty name", () => {
    expect(() => CategoryCreate.parse({ name: "  " })).toThrow();
  });

  it("CategoryUpdate accepts partial fields", () => {
    expect(CategoryUpdate.parse({ isActive: false })).toEqual({ isActive: false });
  });

  it("ProductCreate defaults isVeg true, null station, empty variants", () => {
    const p = ProductCreate.parse({ categoryId: "c1", name: "Paneer Tikka", pricePaise: 25000, gstRate: 5 });
    expect(p.isVeg).toBe(true);
    expect(p.kotStationId).toBeNull();
    expect(p.variants).toEqual([]);
  });

  it("ProductCreate rejects a non-slab GST rate and fractional paise", () => {
    expect(() => ProductCreate.parse({ categoryId: "c1", name: "X", pricePaise: 100, gstRate: 7 })).toThrow();
    expect(() => ProductCreate.parse({ categoryId: "c1", name: "X", pricePaise: 10.5, gstRate: 5 })).toThrow();
  });

  it("ProductCreate accepts inline variants", () => {
    const p = ProductCreate.parse({
      categoryId: "c1", name: "Biryani", pricePaise: 30000, gstRate: 5,
      variants: [{ name: "Half", pricePaise: 18000 }],
    });
    expect(p.variants).toEqual([{ name: "Half", pricePaise: 18000 }]);
  });

  it("ProductUpdate allows clearing the KOT station with null", () => {
    expect(ProductUpdate.parse({ kotStationId: null })).toEqual({ kotStationId: null });
  });

  it("VariantCreate requires a name and integer paise", () => {
    expect(() => VariantCreate.parse({ name: "", pricePaise: 100 })).toThrow();
    expect(VariantCreate.parse({ name: "Full", pricePaise: 100 })).toEqual({ name: "Full", pricePaise: 100 });
  });
});

describe("user schemas", () => {
  it("UserCreate takes name, 4-6 digit pin, and a known role", () => {
    expect(UserCreate.parse({ name: "Ravi", pin: "4321", role: "cashier" }))
      .toEqual({ name: "Ravi", pin: "4321", role: "cashier" });
    expect(() => UserCreate.parse({ name: "Ravi", pin: "12", role: "cashier" })).toThrow();
    expect(() => UserCreate.parse({ name: "Ravi", pin: "4321", role: "owner" })).toThrow();
  });

  it("UserUpdate accepts partial fields including pin", () => {
    expect(UserUpdate.parse({ pin: "9876" })).toEqual({ pin: "9876" });
    expect(UserUpdate.parse({ isActive: false, role: "waiter" })).toEqual({ isActive: false, role: "waiter" });
  });
});

describe("settings schema", () => {
  it("requires restaurantName, defaults the rest to empty strings", () => {
    expect(SettingsUpdate.parse({ restaurantName: "Cafe" })).toEqual({
      restaurantName: "Cafe", address: "", gstin: "", fssai: "", receiptFooter: "",
    });
    expect(() => SettingsUpdate.parse({ restaurantName: " " })).toThrow();
  });
});
