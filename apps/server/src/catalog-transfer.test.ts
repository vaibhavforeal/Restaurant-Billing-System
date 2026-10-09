import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_CSV_COLUMNS, catalogCsv, parseCatalogCsv, uuidv7 } from "@forkflow/domain";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => { await app?.close(); });
const csv = (...rows: string[][]) => catalogCsv([["category", "name", "price", "gst_rate"], ...rows]);
async function preview(token: string, source: string) {
  return app.inject({ method: "POST", url: "/api/catalog/import/preview", headers: auth(token), payload: { csv: source } });
}
async function apply(token: string, source: string) {
  const res = await preview(token, source);
  expect(res.statusCode, res.body).toBe(200);
  return app.inject({ method: "POST", url: "/api/catalog/import", headers: auth(token), payload: { csv: source, revision: res.json().revision } });
}
async function products(token: string) {
  return (await app.inject({ method: "GET", url: "/api/products", headers: auth(token) })).json().products;
}

describe("item CSV transfer", () => {
  it("previews without writes, imports categories and exact paise, and safely repeats ID-less imports", async () => {
    app = freshApp(); const { token } = await setupAdmin(app);
    const source = csv(["Drinks", "Chai", "12.35", "5"], ["Mains", "Dal", "100", "0"]);
    expect((await preview(token, source)).json()).toMatchObject({ created: 2, updated: 0, categoriesCreated: 2 });
    expect(app.db.prepare("SELECT * FROM categories").all()).toHaveLength(0);
    expect(await products(token)).toHaveLength(0);
    expect((await apply(token, source)).statusCode).toBe(200);
    expect((await products(token)).find((p: { name: string }) => p.name === "Chai")).toMatchObject({ pricePaise: 1235, isVeg: true, isActive: true });
    expect((await apply(token, source)).json()).toMatchObject({ created: 0, updated: 2, categoriesCreated: 0 });
    expect(await products(token)).toHaveLength(2);
  });

  it("round-trips variants, inactive flags, Unicode, multiline descriptions and spreadsheet formula escaping", async () => {
    app = freshApp(); const { token } = await setupAdmin(app);
    const category = (await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "पेय, Drinks" } })).json().category;
    const item = (await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: {
      categoryId: category.id, name: '=Tea "special"', pricePaise: 12345, gstRate: 18, isVeg: false,
      isSoldOut: true, description: "Line one,\nLine two \"quoted\"", variants: [{ name: "Large", pricePaise: 15001 }],
    } })).json().product;
    await app.inject({ method: "PATCH", url: `/api/products/${item.id}`, headers: auth(token), payload: { isActive: false } });
    await app.inject({ method: "PATCH", url: `/api/variants/${item.variants[0].id}`, headers: auth(token), payload: { isActive: false } });
    const before = await products(token);
    const exported = await app.inject({ method: "GET", url: "/api/catalog/export", headers: auth(token) });
    expect(exported.headers["cache-control"]).toBe("no-store");
    const source = exported.json().csv;
    expect(source.startsWith("\uFEFF")).toBe(true);
    expect(source).toContain("'=Tea");
    expect(parseCatalogCsv(source)).toHaveLength(2);
    expect((await apply(token, source)).json()).toMatchObject({ created: 0, updated: 1, variantsUpdated: 1 });
    expect(await products(token)).toEqual(before);
    // Exported IDs can also seed an empty installation and remain stable on retries.
    await app.close(); app = freshApp(); const other = await setupAdmin(app);
    expect((await apply(other.token, source)).json()).toMatchObject({ created: 1, variantsCreated: 1 });
    expect(await products(other.token)).toMatchObject([{ id: item.id, name: item.name, isActive: false, variants: [{ id: item.variants[0].id, isActive: false }] }]);
    expect((await apply(other.token, source)).json()).toMatchObject({ created: 0, variantsCreated: 0 });
  });

  it("updates by ID, preserving photos, stock links, omitted variants and historical order snapshots", async () => {
    app = freshApp(); const admin = await setupAdmin(app);
    await apply(admin.token, csv(["Mains", "Dal", "100", "5"]));
    const item = (await products(admin.token))[0];
    app.db.prepare("UPDATE products SET photo_data = 'photo fixture', photo_hash = 'hash fixture' WHERE id = ?").run(item.id);
    const stock = uuidv7();
    app.db.prepare("INSERT INTO stock_items (id,name,unit,qty) VALUES (?, 'Rice', 'kg', 100)").run(stock);
    app.db.prepare("INSERT INTO product_stock_links (id,product_id,stock_item_id,qty_per_sale) VALUES (?,?,?,1)").run(uuidv7(), item.id, stock);
    await app.inject({ method: "POST", url: `/api/products/${item.id}/variants`, headers: auth(admin.token), payload: { name: "Half", pricePaise: 6000 } });
    const order = uuidv7();
    app.db.prepare("INSERT INTO orders (id,client_ref,type,opened_by,opened_at) VALUES (?,?,'parcel',?,?)").run(order, uuidv7(), admin.user.id, Date.now());
    app.db.prepare("INSERT INTO order_items (id,order_id,product_id,name_snapshot,price_paise_snapshot,gst_rate_snapshot,qty) VALUES (?,?,?,'Dal',10000,5,1)").run(uuidv7(), order, item.id);
    const source = catalogCsv([["item_id", "category", "name", "price", "gst_rate"], [item.id, "New category", "Dal fry", "150.50", "12"]]);
    expect((await apply(admin.token, source)).statusCode).toBe(200);
    expect((await products(admin.token))[0]).toMatchObject({ id: item.id, name: "Dal fry", pricePaise: 15050, photoVersion: "hash fixture", variants: [{ name: "Half" }] });
    expect(app.db.prepare("SELECT photo_data FROM products WHERE id=?").get(item.id)).toEqual({ photo_data: "photo fixture" });
    expect(app.db.prepare("SELECT * FROM product_stock_links").all()).toHaveLength(1);
    expect(app.db.prepare("SELECT name_snapshot,price_paise_snapshot FROM order_items").get()).toEqual({ name_snapshot: "Dal", price_paise_snapshot: 10000 });
  });

  it.each([
    ["price", ["New", "Bad", "12.345", "5"], "price"],
    ["negative price", ["New", "Bad", "-1", "5"], "price"],
    ["GST", ["New", "Bad", "12", "7"], "gst_rate"],
    ["fractional GST", ["New", "Bad", "12", "5.5"], "gst_rate"],
    ["blank name", ["New", "", "12", "5"], "name"],
  ])("rejects invalid %s without partial writes", async (_label, bad, field) => {
    app = freshApp(); const { token } = await setupAdmin(app);
    const revision = (await preview(token, csv(["Valid", "First", "20", "5"]))).json().revision;
    const source = csv(["Valid", "First", "20", "5"], bad as string[]);
    const res = await app.inject({ method: "POST", url: "/api/catalog/import", headers: auth(token), payload: { csv: source, revision } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(`Row 3: ${field}`);
    expect(await products(token)).toHaveLength(0);
    expect(app.db.prepare("SELECT * FROM categories").all()).toHaveLength(0);
  });

  it("rejects an unsupported gst_rate with the exact message", async () => {
    app = freshApp(); const { token } = await setupAdmin(app);
    const res = await preview(token, csv(["A", "Tea", "10", "7"]));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Row 2: gst_rate must be blank, 0, 5, 12, 18 or 28.");
  });

  it("treats a blank gst_rate as the restaurant default, for new items and by resetting existing ones", async () => {
    app = freshApp(); const { token } = await setupAdmin(app);
    await apply(token, csv(["A", "Tea", "10", ""], ["A", "Cake", "50", "18"], ["A", "Water", "20", "0"]));
    const rate = async (name: string) => (await products(token)).find((p: { name: string }) => p.name === name).gstRate;
    expect(await rate("Tea")).toBeNull();
    expect(await rate("Cake")).toBe(18);
    expect(await rate("Water")).toBe(0);
    await apply(token, csv(["A", "Cake", "50", ""]));
    expect(await rate("Cake")).toBeNull();
    expect(await rate("Water")).toBe(0);
  });

  it("keeps an existing item's rate when the gst_rate column is absent", async () => {
    app = freshApp(); const { token } = await setupAdmin(app);
    await apply(token, csv(["A", "Cake", "50", "18"]));
    await apply(token, catalogCsv([["category", "name", "price"], ["A", "Cake", "60"], ["A", "Tea", "10"]]));
    const list = await products(token);
    expect(list.find((p: { name: string }) => p.name === "Cake")).toMatchObject({ pricePaise: 6000, gstRate: 18 });
    expect(list.find((p: { name: string }) => p.name === "Tea")).toMatchObject({ gstRate: null });
  });

  it("exports a blank cell for the default rate and the number for an override, and re-import leaves every rate unchanged", async () => {
    app = freshApp(); const { token } = await setupAdmin(app);
    await apply(token, csv(["A", "Tea", "10", ""], ["A", "Cake", "50", "18"], ["A", "Water", "20", "0"], ["A", "Soda", "30", "28"]));
    const rates = async () => (await products(token)).map((p: { name: string; gstRate: number | null }) => [p.name, p.gstRate]).sort();
    const before = await rates();
    expect(before).toEqual([["Cake", 18], ["Soda", 28], ["Tea", null], ["Water", 0]]);
    const source = (await app.inject({ method: "GET", url: "/api/catalog/export", headers: auth(token) })).json().csv;
    const exported = Object.fromEntries(parseCatalogCsv(source).map((r) => [r.values.name, r.values.gst_rate]));
    expect(exported).toEqual({ Tea: "", Cake: "18", Water: "0", Soda: "28" });
    expect((await apply(token, source)).json()).toMatchObject({ created: 0, updated: 4 });
    expect(await rates()).toEqual(before);
  });

  it("rejects stale previews after a catalog change", async () => {
    app = freshApp(); const { token } = await setupAdmin(app);
    const source = csv(["Mains", "Dal", "100", "5"]);
    const p = (await preview(token, source)).json();
    await apply(token, csv(["Drinks", "Tea", "30", "5"]));
    const res = await app.inject({ method: "POST", url: "/api/catalog/import", headers: auth(token), payload: { csv: source, revision: p.revision } });
    expect(res.statusCode).toBe(409);
    expect(await products(token)).toHaveLength(1);
    expect((await apply(token, source)).statusCode).toBe(200);
  });

  it("rejects duplicate items, ambiguous names, wrong variant ownership and unknown kitchen stations", async () => {
    app = freshApp(); const { token } = await setupAdmin(app);
    expect((await preview(token, csv(["A", "Tea", "10", "0"], ["A", "Tea", "10", "0"]))).json().error).toContain("duplicate item row");
    const withStation = catalogCsv([["category", "name", "price", "gst_rate", "kot_station"], ["A", "Tea", "10", "0", "Missing"]]);
    expect((await preview(token, withStation)).json().error).toContain("unknown KOT station");
    await apply(token, csv(["A", "Tea", "10", "0"], ["A", "Coffee", "20", "0"]));
    const [coffee, tea] = await products(token);
    const variant = (await app.inject({ method: "POST", url: `/api/products/${tea.id}/variants`, headers: auth(token), payload: { name: "Large", pricePaise: 2000 } })).json().variant;
    const wrongOwner = catalogCsv([CATALOG_CSV_COLUMNS, [coffee.id, "A", "Coffee", "20", "0", "true", "true", "false", "", "", variant.id, "Large", "30", "true", "", "", "", "", "", ""]]);
    expect((await preview(token, wrongOwner)).json().error).toContain("belongs to another item");
    await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { categoryId: tea.categoryId, name: "Tea", pricePaise: 500, gstRate: 0 } });
    expect((await preview(token, csv(["A", "Tea", "10", "0"]))).json().error).toContain("ambiguous item name");
  });

  it("rolls back the entire import if a database write fails", async () => {
    app = freshApp(); const { token } = await setupAdmin(app);
    app.db.exec("CREATE TRIGGER reject_bad BEFORE INSERT ON products WHEN NEW.name='Bad' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const result = await apply(token, csv(["A", "Good", "1", "0"], ["B", "Bad", "1", "0"]));
    expect(result.statusCode).toBe(500);
    expect(await products(token)).toHaveLength(0);
    expect(app.db.prepare("SELECT * FROM categories").all()).toHaveLength(0);
  });

  it("requires administrator permission for preview, import and export", async () => {
    app = freshApp(); const admin = await setupAdmin(app);
    const cashier = await createUser(app, admin.token, { name: "Cashier", pin: "5678", role: "cashier" });
    for (const path of ["/api/catalog/export", "/api/catalog/import/preview", "/api/catalog/import"]) {
      const method = path.endsWith("export") ? "GET" : "POST";
      expect((await app.inject({ method, url: path, headers: auth(cashier.token) })).statusCode).toBe(403);
      expect((await app.inject({ method, url: path })).statusCode).toBe(401);
    }
  });
});

describe("CSV parsing", () => {
  it("handles Windows newlines, BOM, quotes and reversible formula protection", () => {
    for (const name of ["=SUM(1,2)", " +cmd", "@test", "-test", "'text", "Tea, \"large\"", "चाय"]) {
      expect(parseCatalogCsv(csv(["A", name, "1", "0"]))[0]?.values.name).toBe(name);
    }
    expect(parseCatalogCsv('category,name,price,gst_rate\r\nA,"Tea\r\nlarge",1,0\r\n')[0]?.values.name).toBe("Tea\r\nlarge");
  });
  it.each([
    ["", "empty"],
    ["category,name,price,gst_rate\n", "no items"],
    ["category,name,name,price,gst_rate\nA,B,B,1,0", "duplicated"],
    ["name,price,gst_rate\nB,1,0", "category"],
    ["category,name,price,gst_rate\nA,B,1", "expected 4"],
    ['category,name,price,gst_rate\nA,"B,1,0', "unclosed"],
    ['category,name,price,gst_rate\nA,"B"x,1,0', "closing quote"],
  ])("reports malformed input", (source, error) => { expect(() => parseCatalogCsv(source)).toThrow(error); });
});

describe("Zomato price CSV columns", () => {
  it("stores a null Zomato price when the file has no zomato columns", async () => {
    app = freshApp(); const { token } = await setupAdmin(app);
    expect((await apply(token, csv(["Mains", "Dal", "200", "5"]))).statusCode).toBe(200);
    const [dal] = await products(token);
    expect(dal.zomatoPricePaise).toBeNull();
  });

  it("round-trips item and variant Zomato prices through export and import", async () => {
    app = freshApp(); const { token } = await setupAdmin(app);
    const source = catalogCsv([
      ["category", "name", "price", "gst_rate", "variant_name", "variant_price", "zomato_price", "variant_zomato_price"],
      ["Mains", "Dal", "200", "5", "", "", "290.00", ""],
      ["Mains", "Biryani", "300", "5", "Half", "180", "", "0"],
    ]);
    expect((await apply(token, source)).statusCode).toBe(200);
    const byName = async () => Object.fromEntries((await products(token)).map((p: { name: string }) => [p.name, p]));
    expect((await byName()).Dal.zomatoPricePaise).toBe(29000);
    expect((await byName()).Biryani.zomatoPricePaise).toBeNull();
    expect((await byName()).Biryani.variants[0].zomatoPricePaise).toBe(0);
    const before = await products(token);
    const exported = (await app.inject({ method: "GET", url: "/api/catalog/export", headers: auth(token) })).json().csv as string;
    const rows = parseCatalogCsv(exported);
    expect(rows.find((r) => r.values.name === "Dal")?.values.zomato_price).toBe("290.00");
    expect(rows.find((r) => r.values.variant_name === "Half")?.values.variant_zomato_price).toBe("0.00");
    expect((await apply(token, exported)).statusCode).toBe(200);
    expect(await products(token)).toEqual(before);
  });
});
