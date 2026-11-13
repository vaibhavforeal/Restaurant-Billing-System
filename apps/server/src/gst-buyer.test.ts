import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type Bill } from "@masalapos/domain";
import { auth, enableIntegration, freshApp, setupAdmin } from "./test-helpers.js";
import { receiptSlip } from "@masalapos/print";
import { creditNoteSlip } from "./print/credit-note.js";

const OWN = "29AAPFU0939F1ZR";
const ACME = { gstin: "29AABCU9603R1ZJ", name: "Acme Pvt Ltd", address: "MG Road, Bengaluru" };

/** A bill issued to a registered business: the buyer travels with the bill request, so it works without CRM. */
describe("GST invoice for a business buyer", () => {
  let app: FastifyInstance;
  let token: string;
  let productId: string;

  beforeEach(async () => {
    app = freshApp();
    token = (await setupAdmin(app)).token;
    app.db.prepare("UPDATE settings SET gstin = ? WHERE id = 1").run(OWN);
    const category = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const product = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Thali", categoryId: category.json().category.id, pricePaise: 10500, gstRate: 5, kotStationId: null } });
    productId = product.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  async function openOrder() {
    const created = await app.inject({ method: "POST", url: "/api/orders", headers: auth(token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
    const orderId = created.json().order.id as string;
    await app.inject({ method: "POST", url: `/api/orders/${orderId}/items`, headers: auth(token), payload: { items: [{ productId, qty: 1, clientRef: uuidv7() }] } });
    return orderId;
  }
  const preview = (orderId: string, payload: object) => app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers: auth(token), payload });
  const issue = (orderId: string, payload: object) => app.inject({ method: "POST", url: `/api/orders/${orderId}/bill`, headers: auth(token), payload: { clientRef: uuidv7(), ...payload } });

  it("prints the buyer on the receipt and stores it on the bill", async () => {
    const orderId = await openOrder();
    const shown = await preview(orderId, { buyer: ACME });
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().preview.receipt).toMatchObject({ buyer: { ...ACME, stateCode: "29", stateName: "Karnataka" }, sacCode: "996331" });
    const issued = await issue(orderId, { buyer: ACME, previewKey: shown.json().preview.previewKey });
    expect(issued.statusCode, issued.body).toBe(201);
    const bill = issued.json().bill as Bill;
    expect(bill.receipt.buyer?.gstin).toBe(ACME.gstin);
    expect(app.db.prepare("SELECT buyer_gstin AS gstin, buyer_name AS name, buyer_address AS address FROM bills WHERE id = ?").get(bill.id)).toEqual(ACME);
  });

  it("prints the buyer, place of supply and SAC on the bill and on its credit note", async () => {
    const orderId = await openOrder();
    const shown = await preview(orderId, { buyer: ACME });
    const bill = (await issue(orderId, { buyer: ACME, previewKey: shown.json().preview.previewKey })).json().bill as Bill;
    const html = (await app.inject({ url: `/api/bills/${bill.id}/receipt`, headers: auth(token) })).body;
    for (const text of ["Billed to", "Acme Pvt Ltd", `GSTIN: ${ACME.gstin}`, "MG Road, Bengaluru", "Place of supply", "Karnataka (29)", "996331"]) expect(html).toContain(text);
    const slip = Buffer.from(receiptSlip(bill, 80)).toString("latin1");
    for (const text of ["Billed to: Acme Pvt Ltd", `GSTIN: ${ACME.gstin}`, "Place of supply: Karnataka (29)", "SAC: 996331"]) expect(slip).toContain(text);
    const voided = await app.inject({ method: "POST", url: `/api/bills/${bill.id}/void`, headers: auth(token), payload: { clientRef: uuidv7(), reason: "Wrong buyer", refunds: [] } });
    expect(voided.statusCode, voided.body).toBe(201);
    const after = (await app.inject({ url: `/api/bills/${bill.id}`, headers: auth(token) })).json().bill as Bill;
    const note = after.creditNotes[0]!;
    const noteHtml = (await app.inject({ url: `/api/credit-notes/${note.id}/receipt`, headers: auth(token) })).body;
    expect(noteHtml).toContain(`GSTIN: ${ACME.gstin}`);
    expect(Buffer.from(creditNoteSlip({ ...note, taxes: [] }, after, 80)).toString("latin1")).toContain("Billed to: Acme Pvt Ltd");
  });

  it("leaves walk-in bills without a buyer", async () => {
    const orderId = await openOrder();
    const shown = await preview(orderId, {});
    expect(shown.json().preview.receipt.buyer).toBeUndefined();
    const issued = await issue(orderId, { previewKey: shown.json().preview.previewKey });
    expect(app.db.prepare("SELECT buyer_gstin FROM bills WHERE id = ?").get(issued.json().bill.id)).toEqual({ buyer_gstin: null });
  });

  it("refuses a bad GSTIN, the restaurant's own GSTIN, and a restaurant without a GSTIN", async () => {
    const orderId = await openOrder();
    expect((await preview(orderId, { buyer: { ...ACME, gstin: "29AABCU9603R1ZK" } })).statusCode).toBe(400);
    const own = await preview(orderId, { buyer: { ...ACME, gstin: OWN } });
    expect(own.statusCode).toBe(400);
    expect(own.json().error).toMatch(/your own GSTIN/);
    app.db.prepare("UPDATE settings SET gstin = '' WHERE id = 1").run();
    const unregistered = await preview(orderId, { buyer: ACME });
    expect(unregistered.statusCode).toBe(400);
    expect(unregistered.json().error).toMatch(/restaurant's GSTIN/);
  });

  it("asks for a fresh preview when the buyer changes after previewing", async () => {
    const orderId = await openOrder();
    const shown = await preview(orderId, {});
    const issued = await issue(orderId, { buyer: ACME, previewKey: shown.json().preview.previewKey });
    expect(issued.statusCode).toBe(409);
  });
});

describe("business customers and GST settings", () => {
  let app: FastifyInstance;
  let token: string;
  beforeEach(async () => { app = freshApp(); token = (await setupAdmin(app)).token; enableIntegration(app, "crm"); });
  afterEach(async () => { await app.close(); app.db.close(); });

  it("keeps a customer's GSTIN and legal name, and needs the name for a GSTIN", async () => {
    const created = await app.inject({ method: "POST", url: "/api/customers", headers: auth(token),
      payload: { name: "Acme canteen", phone: "9845012345", gstin: ACME.gstin, legalName: ACME.name } });
    expect(created.statusCode, created.body).toBe(201);
    const customer = created.json().customer;
    expect(customer).toMatchObject({ gstin: ACME.gstin, legalName: ACME.name });
    const cleared = await app.inject({ method: "PATCH", url: `/api/customers/${customer.id}`, headers: auth(token), payload: { legalName: "" } });
    expect(cleared.statusCode).toBe(400);
    const removed = await app.inject({ method: "PATCH", url: `/api/customers/${customer.id}`, headers: auth(token), payload: { gstin: "", legalName: "" } });
    expect(removed.json().customer).toMatchObject({ gstin: null, legalName: null });
  });

  it("saves the SAC code and Zomato GSTIN, checking Zomato's state against the restaurant's", async () => {
    const put = (payload: object) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Cafe", ...payload } });
    const saved = await put({ sacCode: "996332", zomatoGstin: ACME.gstin });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().settings).toMatchObject({ sacCode: "996332", zomatoGstin: ACME.gstin });
    expect((await put({})).json().settings).toMatchObject({ sacCode: "996332", zomatoGstin: ACME.gstin });
    expect((await put({ zomatoGstin: "27AABCU9603R1ZN" })).statusCode).toBe(400);
  });
});
