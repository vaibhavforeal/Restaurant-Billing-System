import { afterEach, describe, expect, it } from "vitest";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

describe("settings", () => {
  it("returns the profile seeded at setup and updates it wholesale", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const before = await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) });
    expect(before.statusCode).toBe(200);
    // setup wrote the restaurant name into the settings singleton
    expect(before.json().settings).toEqual({
      restaurantName: "Cafe Test", address: "", gstin: "", fssai: "", receiptFooter: "", taxInclusive: false, requireKitchenAcceptance: true, upiId: "",
    });

    const put = await app.inject({
      method: "PUT", url: "/api/settings",
      payload: {
        restaurantName: "Cafe Nirvana", address: "12 MG Road, Hubli",
        gstin: "29ABCDE1234F1Z5", fssai: "11223344556677", receiptFooter: "Thank you, visit again!",
      },
      headers: auth(admin.token),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.restaurantName).toBe("Cafe Nirvana");

    const after = await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) });
    expect(after.json().settings).toMatchObject({ gstin: "29ABCDE1234F1Z5", receiptFooter: "Thank you, visit again!" });
  });

  it("rejects a blank restaurant name with 400", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const res = await app.inject({
      method: "PUT", url: "/api/settings",
      payload: { restaurantName: "  " }, headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("is admin-only", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const cashier = await createUser(app, admin.token, { name: "Ravi", pin: "4321", role: "cashier" });
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: auth(cashier.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/settings", headers: auth(cashier.token), payload: { restaurantName: "Cafe", upiId: "other@bank" } })).statusCode).toBe(403);
  });

  it("validates and trims UPI IDs, preserves omitted IDs, and supports disabling", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const save = (fields: object) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe", ...fields } });
    expect((await save({ upiId: "  cafe.123@okbank  " })).json().settings.upiId).toBe("cafe.123@okbank");
    for (const upiId of ["cafe", "@bank", "cafe@", "a b@bank", "cafe@bank&am=1", "upi://pay?pa=cafe@bank", "a".repeat(256) + "@bank", null]) {
      expect((await save({ upiId })).statusCode).toBe(400);
    }
    expect((await save({ address: "New address" })).json().settings.upiId).toBe("cafe.123@okbank");
    expect((await save({ upiId: " " })).json().settings.upiId).toBe("");
  });
});
