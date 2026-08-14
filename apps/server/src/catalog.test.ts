import { afterEach, describe, expect, it } from "vitest";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

async function addCategory(adminToken: string, name: string, sortOrder = 0) {
  const res = await app.inject({
    method: "POST", url: "/api/categories",
    payload: { name, sortOrder }, headers: auth(adminToken),
  });
  return res.json() as { category: { id: string } };
}

describe("categories", () => {
  it("creates and lists categories in sort order", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const res = await app.inject({
      method: "POST", url: "/api/categories",
      payload: { name: "Starters" }, headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().category).toMatchObject({ name: "Starters", sortOrder: 0, isActive: true });

    await addCategory(admin.token, "Desserts", 2);
    await addCategory(admin.token, "Mains", 1);

    const list = await app.inject({ method: "GET", url: "/api/categories", headers: auth(admin.token) });
    expect(list.statusCode).toBe(200);
    expect(list.json().categories.map((c: { name: string }) => c.name)).toEqual(["Starters", "Mains", "Desserts"]);
  });

  it("renames, reorders, and deactivates via PATCH; 404s on unknown id", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { category } = await addCategory(admin.token, "Starters");

    const patched = await app.inject({
      method: "PATCH", url: `/api/categories/${category.id}`,
      payload: { name: "Appetisers", sortOrder: 5, isActive: false }, headers: auth(admin.token),
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().category).toMatchObject({ name: "Appetisers", sortOrder: 5, isActive: false });

    const missing = await app.inject({
      method: "PATCH", url: "/api/categories/nope",
      payload: { name: "X" }, headers: auth(admin.token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("read is open to waiters, write is not; anonymous is 401", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const waiter = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });

    expect((await app.inject({ method: "GET", url: "/api/categories", headers: auth(waiter.token) })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST", url: "/api/categories", payload: { name: "X" }, headers: auth(waiter.token),
    })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/categories" })).statusCode).toBe(401);
  });
});

describe("products and variants", () => {
  async function cat(adminToken: string, name = "Mains") {
    return (await addCategory(adminToken, name)).category;
  }

  it("creates a product with inline variants and lists it nested", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const c = await cat(admin.token);

    const res = await app.inject({
      method: "POST", url: "/api/products",
      payload: {
        categoryId: c.id, name: "Biryani", pricePaise: 30000, gstRate: 5,
        isVeg: false, variants: [{ name: "Half", pricePaise: 18000 }],
      },
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(201);
    const { product } = res.json();
    expect(product).toMatchObject({
      categoryId: c.id, name: "Biryani", pricePaise: 30000, gstRate: 5,
      isVeg: false, kotStationId: null, isActive: true,
    });
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0]).toMatchObject({ name: "Half", pricePaise: 18000, isActive: true });

    const list = await app.inject({ method: "GET", url: "/api/products", headers: auth(admin.token) });
    expect(list.json().products).toHaveLength(1);
    expect(list.json().products[0].variants).toHaveLength(1);
  });

  it("rejects unknown category/station references with 400, not a 500", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const c = await cat(admin.token);

    const badCat = await app.inject({
      method: "POST", url: "/api/products",
      payload: { categoryId: "nope", name: "X", pricePaise: 100, gstRate: 5 },
      headers: auth(admin.token),
    });
    expect(badCat.statusCode).toBe(400);
    expect(badCat.json().error).toBe("unknown category");

    const badStation = await app.inject({
      method: "POST", url: "/api/products",
      payload: { categoryId: c.id, name: "X", pricePaise: 100, gstRate: 5, kotStationId: "nope" },
      headers: auth(admin.token),
    });
    expect(badStation.statusCode).toBe(400);
    expect(badStation.json().error).toBe("unknown KOT station");
  });

  it("assigns the seeded Kitchen station and clears it with null", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const c = await cat(admin.token);

    const stations = await app.inject({ method: "GET", url: "/api/kot-stations", headers: auth(admin.token) });
    expect(stations.statusCode).toBe(200);
    const kitchen = stations.json().stations[0];
    expect(kitchen.name).toBe("Kitchen");

    const created = await app.inject({
      method: "POST", url: "/api/products",
      payload: { categoryId: c.id, name: "Dal", pricePaise: 12000, gstRate: 5, kotStationId: kitchen.id },
      headers: auth(admin.token),
    });
    expect(created.json().product.kotStationId).toBe(kitchen.id);

    const cleared = await app.inject({
      method: "PATCH", url: `/api/products/${created.json().product.id}`,
      payload: { kotStationId: null }, headers: auth(admin.token),
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().product.kotStationId).toBeNull();
  });

  it("updates product fields and 404s on unknown ids", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const c = await cat(admin.token);
    const { product } = (await app.inject({
      method: "POST", url: "/api/products",
      payload: { categoryId: c.id, name: "Dal", pricePaise: 12000, gstRate: 5 },
      headers: auth(admin.token),
    })).json();

    const patched = await app.inject({
      method: "PATCH", url: `/api/products/${product.id}`,
      payload: { name: "Dal Tadka", pricePaise: 14000, gstRate: 12, isActive: false },
      headers: auth(admin.token),
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().product).toMatchObject({ name: "Dal Tadka", pricePaise: 14000, gstRate: 12, isActive: false });

    expect((await app.inject({
      method: "PATCH", url: "/api/products/nope", payload: { name: "X" }, headers: auth(admin.token),
    })).statusCode).toBe(404);
  });

  it("adds and edits variants after creation", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const c = await cat(admin.token);
    const { product } = (await app.inject({
      method: "POST", url: "/api/products",
      payload: { categoryId: c.id, name: "Biryani", pricePaise: 30000, gstRate: 5 },
      headers: auth(admin.token),
    })).json();

    const added = await app.inject({
      method: "POST", url: `/api/products/${product.id}/variants`,
      payload: { name: "Half", pricePaise: 18000 }, headers: auth(admin.token),
    });
    expect(added.statusCode).toBe(201);
    const variant = added.json().variant;

    const patched = await app.inject({
      method: "PATCH", url: `/api/variants/${variant.id}`,
      payload: { pricePaise: 19000, isActive: false }, headers: auth(admin.token),
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().variant).toMatchObject({ name: "Half", pricePaise: 19000, isActive: false });

    expect((await app.inject({
      method: "POST", url: "/api/products/nope/variants",
      payload: { name: "X", pricePaise: 1 }, headers: auth(admin.token),
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "PATCH", url: "/api/variants/nope",
      payload: { name: "X" }, headers: auth(admin.token),
    })).statusCode).toBe(404);
  });

  it("write routes are 403 for cashiers (read-only role for catalog)", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const c = await cat(admin.token);
    const cashier = await createUser(app, admin.token, { name: "Ravi", pin: "4321", role: "cashier" });

    expect((await app.inject({ method: "GET", url: "/api/products", headers: auth(cashier.token) })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST", url: "/api/products",
      payload: { categoryId: c.id, name: "X", pricePaise: 100, gstRate: 5 },
      headers: auth(cashier.token),
    })).statusCode).toBe(403);
  });
});
