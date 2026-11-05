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
      restaurantName: "Cafe Test", address: "12 MG Road", city: "Bengaluru", stateCode: "29", pincode: "560001", phone: "9845012345", gstin: "", fssai: "", receiptFooter: "", receiptHeader: "", billShowFssai: true, billShowCustomer: true, billShowTable: true, billShowServedBy: false, billShowItemGst: false, upiId: "", receiptStyle: "classic", gstMode: "included", gstRate: 5, kotEditPrint: "ask", holdOrdersEnabled: true, popularItemsEnabled: true, popularByTimeEnabled: true, orderedTogetherEnabled: true, customerUsualEnabled: true, sacCode: "996331", zomatoGstin: "", invoicePrefix: "", roundOff: "rupee",
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

  it("previews an unsaved bill", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const preview = (token: string, payload: object) => app.inject({ method: "POST", url: "/api/settings/bill-preview", headers: auth(token), payload });
    const ok = await preview(admin.token, { restaurantName: "Cafe Test", address: "12 MG Road", receiptHeader: "Pure veg", billShowFssai: false, fssai: "11223344556677" });
    expect(ok.statusCode).toBe(200);
    const { html } = ok.json() as { html: string };
    expect(html).toContain("Pure veg");
    expect(html).toContain("Paneer Tikka");
    expect(html).not.toContain("FSSAI:");
    const saved = await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) });
    expect(saved.json().settings.receiptHeader).toBe("");
    expect((await preview(admin.token, { restaurantName: "Cafe", address: "FC Road", receiptHeader: "a\nb\nc\nd" })).statusCode).toBe(400);
    const cashier = await createUser(app, admin.token, { name: "Ravi", pin: "4321", role: "cashier" });
    expect((await preview(cashier.token, { restaurantName: "Cafe", address: "FC Road" })).statusCode).toBe(403);
  });

  it("previews the invoice number from the unsaved prefix", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const res = await app.inject({ method: "POST", url: "/api/settings/bill-preview", headers: auth(admin.token),
      payload: { restaurantName: "Cafe Test", address: "12 MG Road", invoicePrefix: "MP" } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { html: string }).html).toContain("MP/26-27/0001");
  });

  it("saves bill header lines and print toggles, and keeps toggles a PUT leaves out", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const put = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token),
      payload: { restaurantName: "Cafe", address: "FC Road", receiptHeader: "Pure veg\nSince 1998", billShowFssai: false, billShowServedBy: true } });
    expect(put.statusCode, put.body).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) });
    expect(get.json().settings).toMatchObject({ receiptHeader: "Pure veg\nSince 1998", billShowFssai: false, billShowServedBy: true, billShowCustomer: true, billShowTable: true, billShowItemGst: false });
    const partial = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe", address: "FC Road" } });
    expect(partial.json().settings).toMatchObject({ billShowFssai: false, billShowServedBy: true });
  });

  it("saves the invoice prefix upper-cased and the round-off mode, and keeps them when a PUT leaves them out", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const put = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token),
      payload: { restaurantName: "Cafe", address: "FC Road", invoicePrefix: " mp ", roundOff: "half" } });
    expect(put.statusCode, put.body).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) });
    expect(get.json().settings).toMatchObject({ invoicePrefix: "MP", roundOff: "half" });
    const partial = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe", address: "FC Road" } });
    expect(partial.json().settings).toMatchObject({ invoicePrefix: "MP", roundOff: "half" });
  });

  it("defaults to no prefix and rupee round-off", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const get = await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) });
    expect(get.json().settings).toMatchObject({ invoicePrefix: "", roundOff: "rupee" });
  });

  it("refuses the CN prefix, a long prefix and an unknown round-off mode with a 400", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const put = (extra: object) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe", address: "FC Road", ...extra } });
    const cn = await put({ invoicePrefix: "cn" });
    expect(cn.statusCode).toBe(400);
    expect(JSON.stringify(cn.json())).toContain("credit notes");
    expect((await put({ invoicePrefix: "ABCDE" })).statusCode).toBe(400);
    expect((await put({ roundOff: "paise" })).statusCode).toBe(400);
  });

  it("refuses a footer of 4 lines with a 400", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const put = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token),
      payload: { restaurantName: "Cafe", address: "FC Road", receiptFooter: "a\nb\nc\nd" } });
    expect(put.statusCode).toBe(400);
    expect(JSON.stringify(put.json())).toContain("Footer lines: use up to 3 lines of 48 characters each");
  });

  it("updates city, state, PIN code and phone, and keeps them when a PUT leaves them out", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const put = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token),
      payload: { restaurantName: "Cafe", address: "FC Road", city: "Pune", stateCode: "27", pincode: "411004", phone: "020 2553 1234" } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().settings).toMatchObject({ address: "FC Road", city: "Pune", stateCode: "27", pincode: "411004", phone: "2025531234" });
    const partial = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe", address: "FC Road" } });
    expect(partial.json().settings).toMatchObject({ city: "Pune", stateCode: "27", pincode: "411004", phone: "2025531234" });
  });

  it("refuses a malformed GSTIN, PIN code or phone, and a GSTIN from another state", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const put = (payload: object) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe", ...payload } });
    expect((await put({ gstin: "29ABC" })).statusCode).toBe(400);
    expect((await put({ pincode: "0123" })).statusCode).toBe(400);
    expect((await put({ phone: "123" })).statusCode).toBe(400);
    expect((await put({ stateCode: "29", gstin: "27ABCDE1234F1Z5" })).statusCode).toBe(400);
    // The state on file (Karnataka, from setup) applies when the PUT does not name one.
    expect((await put({ gstin: "27ABCDE1234F1Z5" })).statusCode).toBe(400);
    expect((await put({ gstin: "29ABCDE1234F1Z5" })).statusCode).toBe(200);
  });

  it("ignores the removed requireKitchenAcceptance field", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const put = await app.inject({ method: "PUT", url: "/api/settings", payload: { restaurantName: "Cafe", requireKitchenAcceptance: false }, headers: auth(admin.token) });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings).not.toHaveProperty("requireKitchenAcceptance");
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
  it("saves supported receipt styles, preserves omitted choices, and rejects unknown styles", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const save = (fields: object) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe", ...fields } });
    for (const receiptStyle of ["modern", "heritage", "compact", "classic"]) {
      expect((await save({ receiptStyle })).json().settings.receiptStyle).toBe(receiptStyle);
      expect((await save({ address: "New address" })).json().settings.receiptStyle).toBe(receiptStyle);
    }
    for (const receiptStyle of ["other", "", null, '<style>body{display:none}</style>']) {
      expect((await save({ receiptStyle })).statusCode).toBe(400);
    }
  });
  it("saves the GST mode and default rate, preserves them when omitted, and rejects unsupported values", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const save = (fields: object) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe", ...fields } });
    expect((await save({ gstMode: "none", gstRate: 18 })).json().settings).toMatchObject({ gstMode: "none", gstRate: 18 });
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) })).json().settings).toMatchObject({ gstMode: "none", gstRate: 18 });
    expect((await save({ address: "New address" })).json().settings).toMatchObject({ gstMode: "none", gstRate: 18 });
    expect((await save({ gstMode: "included" })).json().settings).toMatchObject({ gstMode: "included", gstRate: 18 });
    expect((await save({ gstRate: 12 })).json().settings).toMatchObject({ gstMode: "included", gstRate: 12 });
    for (const fields of [{ gstRate: 28 }, { gstRate: 0 }, { gstMode: "exclusive" }, { gstMode: null }, { gstRate: null }]) {
      expect((await save(fields)).statusCode, JSON.stringify(fields)).toBe(400);
    }
    expect((await save({ address: "Again" })).json().settings).toMatchObject({ gstMode: "included", gstRate: 12 });
  });
  it("no longer exposes taxInclusive or gstScheme", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { settings } = (await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) })).json();
    expect(settings).not.toHaveProperty("taxInclusive");
    expect(settings).not.toHaveProperty("gstScheme");
  });

  it("round-trips holdOrdersEnabled and tells open screens", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const events: string[] = [];
    const broadcast = app.broadcast.bind(app);
    app.broadcast = (event, data) => { events.push(event); broadcast(event, data); };
    const off = await app.inject({ method: "PUT", url: "/api/settings", payload: { restaurantName: "Cafe", holdOrdersEnabled: false }, headers: auth(admin.token) });
    expect(off.json().settings.holdOrdersEnabled).toBe(false);
    expect(events).toContain("settings.changed");
    // Leaving the field out keeps the saved value, like kotEditPrint.
    const kept = await app.inject({ method: "PUT", url: "/api/settings", payload: { restaurantName: "Cafe" }, headers: auth(admin.token) });
    expect(kept.json().settings.holdOrdersEnabled).toBe(false);
  });

  it("order settings are readable by a waiter", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const waiter = await createUser(app, admin.token, { name: "Ravi", pin: "4321", role: "waiter" });
    const read = () => app.inject({ method: "GET", url: "/api/order-settings", headers: auth(waiter.token) });
    expect((await read()).statusCode).toBe(200);
    expect((await read()).json()).toEqual({ holdOrders: true });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { restaurantName: "Cafe", holdOrdersEnabled: false }, headers: auth(admin.token) });
    expect((await read()).json()).toEqual({ holdOrders: false });
  });
});
