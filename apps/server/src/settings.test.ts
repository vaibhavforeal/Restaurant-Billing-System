import { afterEach, describe, expect, it } from "vitest";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";
import { readBillingSettings } from "./gst-settings.js";

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
      restaurantName: "Cafe Test", address: "12 MG Road", city: "Bengaluru", stateCode: "29", pincode: "560001", phone: "9845012345", gstin: "", fssai: "", receiptFooter: "", receiptHeader: "", billShowFssai: true, billShowCustomer: true, billShowTable: true, billShowServedBy: false, billShowItemGst: false, upiId: "", receiptStyle: "classic", gstMode: "included", gstRate: 5, kotEditPrint: "ask", holdOrdersEnabled: true, popularItemsEnabled: true, popularByTimeEnabled: true, orderedTogetherEnabled: true, customerUsualEnabled: true, sacCode: "996331", zomatoGstin: "", invoicePrefix: "", roundOff: "rupee", serviceChargeBp: 0, packagingChargePaise: 0, serviceChargeLabel: "Service charge", packagingChargeLabel: "Packaging", packagingPerItem: false,
      orderWarnMinutes: 15, orderLateMinutes: 25, kotPrintWithKds: true, paymentModes: ["cash", "card", "upi"], qrAutoAccept: false, dayStartHour: 0,
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

  it("saves the bill charges, keeps them on unrelated saves and defaults blank labels", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const save = (payload: object) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe Test", ...payload } });
    const charges = { serviceChargeBp: 1000, packagingChargePaise: 2000, serviceChargeLabel: "Service", packagingChargeLabel: "Box" };
    const put = await save(charges);
    expect(put.statusCode).toBe(200);
    expect(put.json().settings).toMatchObject(charges);
    expect((await save({ address: "New road" })).json().settings).toMatchObject(charges);
    expect((await save({ serviceChargeLabel: "  " })).json().settings).toMatchObject({ serviceChargeLabel: "Service charge", packagingChargeLabel: "Box", serviceChargeBp: 1000 });
    expect((await save({ serviceChargeBp: 2001 })).statusCode).toBe(400);
    expect((await save({ packagingChargeLabel: "" })).json().settings).toMatchObject({ packagingChargeLabel: "Packaging", serviceChargeLabel: "Service charge" });
    for (const packagingChargePaise of [-1, 100001, 12.5]) expect((await save({ packagingChargePaise })).statusCode, String(packagingChargePaise)).toBe(400);
    expect((await save({ packagingChargeLabel: "x".repeat(25) })).statusCode).toBe(400);
    expect((await save({ packagingChargePaise: 100000 })).json().settings.packagingChargePaise).toBe(100000);
  });

  it("saves the per-item packaging toggle and keeps it on saves without it", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const save = (payload: object) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe Test", ...payload } });
    expect((await save({ packagingPerItem: true })).statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) });
    expect(get.json().settings.packagingPerItem).toBe(true);
    expect(readBillingSettings(app.db).packagingPerItem).toBe(true);
    expect((await save({ address: "New road" })).json().settings.packagingPerItem).toBe(true);
    expect((await save({ packagingPerItem: false })).json().settings.packagingPerItem).toBe(false);
    expect(readBillingSettings(app.db).packagingPerItem).toBe(false);
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

  it("previews the service charge from the form, falling back to the saved settings", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const base = { restaurantName: "Cafe Test", address: "12 MG Road" };
    const preview = async (payload: object) => (await app.inject({ method: "POST", url: "/api/settings/bill-preview", headers: auth(admin.token), payload: { ...base, ...payload } })).json().html as string;
    expect(await preview({})).not.toContain("Service charge");
    expect(await preview({ serviceChargeBp: 1000 })).toContain("Service charge 10%");
    expect(await preview({ serviceChargeBp: 1250, serviceChargeLabel: "Staff fee" })).toContain("Staff fee 12.5%");
    const put = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { ...base, serviceChargeBp: 500, serviceChargeLabel: "Service" } });
    expect(put.statusCode, put.body).toBe(200);
    expect(await preview({})).toContain("Service 5%");
    // Blank means the default, as on save; an omitted label keeps the saved one.
    expect(await preview({ serviceChargeLabel: " " })).toContain("Service charge 5%");
    expect(await preview({ serviceChargeBp: 0 })).not.toContain("Service 5%");
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
    for (const fields of [{ gstRate: 28 }, { gstRate: 0 }, { gstMode: null }, { gstRate: null }]) {
      expect((await save(fields)).statusCode, JSON.stringify(fields)).toBe(400);
    }
    expect((await save({ address: "Again" })).json().settings).toMatchObject({ gstMode: "included", gstRate: 12 });
  });
  it("saves exclusive mode when a GSTIN is set", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const res = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe", gstin: "29ABCDE1234F1Z5", gstMode: "exclusive" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.gstMode).toBe("exclusive");
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) })).json().settings.gstMode).toBe("exclusive");
  });
  it("rejects exclusive mode without a GSTIN", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const save = (fields: object) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe", ...fields } });
    const bare = await save({ gstMode: "exclusive" });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error).toBe("Add your GSTIN before adding GST to bills");
    expect((await save({ gstin: "29ABCDE1234F1Z5", gstMode: "exclusive" })).statusCode).toBe(200);
    // Blanking the GSTIN while the saved mode is exclusive is rejected too.
    const blanked = await save({ gstin: "" });
    expect(blanked.statusCode).toBe(400);
    expect(blanked.json().error).toBe("Add your GSTIN before adding GST to bills");
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) })).json().settings).toMatchObject({ gstMode: "exclusive", gstin: "29ABCDE1234F1Z5" });
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
    expect((await read()).json()).toEqual({ holdOrders: true, orderWarnMinutes: 15, orderLateMinutes: 25, paymentModes: ["cash", "card", "upi"], dayStartHour: 0 });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { restaurantName: "Cafe", holdOrdersEnabled: false }, headers: auth(admin.token) });
    expect((await read()).json()).toMatchObject({ holdOrders: false });
  });
});

describe("service settings", () => {
  const save = (admin: { token: string }, payload: object) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(admin.token), payload: { restaurantName: "Cafe Test", ...payload } });

  it("saves each one and keeps it on unrelated saves", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const saved = await save(admin, { orderWarnMinutes: 10, orderLateMinutes: 20, kotPrintWithKds: false, paymentModes: ["upi", "cash"], qrAutoAccept: true, dayStartHour: 4 });
    expect(saved.statusCode).toBe(200);
    // Payment methods come back in the counter's order whatever order they were sent in.
    expect(saved.json().settings).toMatchObject({ orderWarnMinutes: 10, orderLateMinutes: 20, kotPrintWithKds: false, paymentModes: ["cash", "upi"], qrAutoAccept: true, dayStartHour: 4 });
    const kept = await save(admin, {});
    expect(kept.json().settings).toMatchObject({ orderWarnMinutes: 10, orderLateMinutes: 20, kotPrintWithKds: false, paymentModes: ["cash", "upi"], qrAutoAccept: true, dayStartHour: 4 });
  });

  it("refuses red before amber, no payment method and a day start past 6 a.m.", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    expect((await save(admin, { orderWarnMinutes: 20, orderLateMinutes: 20 })).statusCode).toBe(400);
    // Only amber sent: it is checked against the saved red (25).
    expect((await save(admin, { orderWarnMinutes: 30 })).statusCode).toBe(400);
    expect((await save(admin, { orderLateMinutes: 10 })).statusCode).toBe(400);
    expect((await save(admin, { paymentModes: [] })).statusCode).toBe(400);
    expect((await save(admin, { paymentModes: ["cash", "cash"] })).statusCode).toBe(400);
    expect((await save(admin, { dayStartHour: 7 })).statusCode).toBe(400);
    const after = await app.inject({ method: "GET", url: "/api/settings", headers: auth(admin.token) });
    expect(after.json().settings).toMatchObject({ orderWarnMinutes: 15, orderLateMinutes: 25, paymentModes: ["cash", "card", "upi"], dayStartHour: 0 });
  });

  it("gives staff the order-age minutes and payment methods", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const cashier = await createUser(app, admin.token, { name: "Meena", pin: "5678", role: "cashier" });
    await save(admin, { orderWarnMinutes: 8, orderLateMinutes: 12, paymentModes: ["upi"], dayStartHour: 3 });
    const read = await app.inject({ method: "GET", url: "/api/order-settings", headers: auth(cashier.token) });
    expect(read.json()).toEqual({ holdOrders: true, orderWarnMinutes: 8, orderLateMinutes: 12, paymentModes: ["upi"], dayStartHour: 3 });
  });
});
