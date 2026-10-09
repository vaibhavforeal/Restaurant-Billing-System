import { describe, expect, it } from "vitest";
import { CATALOG_CSV_COLUMNS, catalogCsv, parseCatalogCsv } from "./catalog-csv.js";
import { ProductCreate, ProductUpdate, VariantCreate, VariantUpdate } from "./catalog-schemas.js";

describe("catalog CSV Zomato columns", () => {
  it("includes the Zomato price columns", () => {
    expect(CATALOG_CSV_COLUMNS).toContain("zomato_price");
    expect(CATALOG_CSV_COLUMNS).toContain("variant_zomato_price");
  });
  it("parses a CSV without zomato_price, leaving the value absent", () => {
    const csv = catalogCsv([["category", "name", "price", "gst_rate"], ["Mains", "Dal", "250.00", "5"]]);
    const [row] = parseCatalogCsv(csv);
    expect(row?.values.zomato_price).toBeUndefined();
    expect(row?.values.name).toBe("Dal");
  });
  it("round-trips zomato_price and variant_zomato_price", () => {
    const csv = catalogCsv([["category", "name", "price", "gst_rate", "zomato_price", "variant_zomato_price"], ["Mains", "Dal", "250.00", "5", "290.00", "310.00"]]);
    const [row] = parseCatalogCsv(csv);
    expect(row?.values.zomato_price).toBe("290.00");
    expect(row?.values.variant_zomato_price).toBe("310.00");
  });
});

describe("catalog CSV gst_rate column", () => {
  it("accepts a header without gst_rate", () => {
    const [row] = parseCatalogCsv(catalogCsv([["category", "name", "price"], ["Mains", "Dal", "250.00"]]));
    expect(row?.values.gst_rate).toBeUndefined();
    expect(row?.values.name).toBe("Dal");
  });
  it("still requires category, name and price", () => {
    expect(() => parseCatalogCsv(catalogCsv([["name", "price"], ["Dal", "250"]]))).toThrow("Missing required column: category.");
    expect(() => parseCatalogCsv(catalogCsv([["category", "name", "gst_rate"], ["A", "Dal", ""]]))).toThrow("Missing required column: price.");
  });
});

describe("catalog schemas Zomato price", () => {
  it("accepts a nullable optional zomatoPricePaise on products and variants", () => {
    expect(ProductCreate.parse({ categoryId: "c1", name: "Dal", pricePaise: 25000, gstRate: 5, zomatoPricePaise: 29000 }).zomatoPricePaise).toBe(29000);
    expect(ProductCreate.parse({ categoryId: "c1", name: "Dal", pricePaise: 25000, gstRate: 5, zomatoPricePaise: null }).zomatoPricePaise).toBeNull();
    expect(ProductCreate.parse({ categoryId: "c1", name: "Dal", pricePaise: 25000, gstRate: 5 }).zomatoPricePaise).toBeUndefined();
    expect(ProductUpdate.parse({ zomatoPricePaise: 0 }).zomatoPricePaise).toBe(0);
    expect(ProductUpdate.parse({ zomatoPricePaise: null }).zomatoPricePaise).toBeNull();
    expect(VariantCreate.parse({ name: "Large", pricePaise: 30000, zomatoPricePaise: 34000 }).zomatoPricePaise).toBe(34000);
    expect(VariantUpdate.parse({ zomatoPricePaise: null }).zomatoPricePaise).toBeNull();
    expect(() => ProductUpdate.parse({ zomatoPricePaise: -1 })).toThrow();
  });
});
