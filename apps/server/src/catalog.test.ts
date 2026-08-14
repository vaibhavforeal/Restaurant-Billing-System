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
