import { describe, expect, it } from "vitest";
import { ProductCreate, ProductUpdate, VariantCreate, VariantUpdate } from "./catalog-schemas.js";

describe("catalogue prices", () => {
  it("rejects a price larger than a bill can hold", () => {
    const product = { categoryId: "c", name: "Thali", pricePaise: 1_000_000_000 };
    expect(ProductCreate.safeParse(product).success).toBe(true);
    expect(ProductCreate.safeParse({ ...product, pricePaise: 1_000_000_001 }).success).toBe(false);
    expect(ProductCreate.safeParse({ ...product, acPricePaise: 10_000_000_000 }).success).toBe(false);
    expect(ProductUpdate.safeParse({ zomatoPricePaise: 1_000_000_001 }).success).toBe(false);
    expect(VariantCreate.safeParse({ name: "Full", pricePaise: 1_000_000_001 }).success).toBe(false);
    expect(VariantUpdate.safeParse({ takeawayPricePaise: 1_000_000_001 }).success).toBe(false);
  });
});
