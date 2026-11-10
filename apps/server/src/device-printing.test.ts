import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { ADMIN_LOGIN, SETUP, auth, freshAppWithFakeSink, joinDevice } from "./test-helpers.js";

const A = "a".repeat(64), B = "b".repeat(64);
type Headers = Record<string, string>;

/**
 * Which printer a request reaches. Browser A is the main counter and has no bill printer; browser B is "Two", whose bill
 * printer is `front`. `back` is a second printer, used as the choice for one request.
 */
describe("printing from a device", () => {
  let app: FastifyInstance, mainToken: string, productId: string, front: string, back: string;
  let main: Headers, two: Headers;
  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink());
    mainToken = (await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-masalapos-device": A } })).json().token;
    main = { ...auth(mainToken), "x-masalapos-device": A };
    await joinDevice(app, main, B, { kind: "counter", name: "Two" });
    const signedIn = await app.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN, headers: { "x-masalapos-device": B } });
    two = { ...auth(signedIn.json().token), "x-masalapos-device": B };
    const category = await app.inject({ method: "POST", url: "/api/categories", headers: main, payload: { name: "Food" } });
    const product = await app.inject({ method: "POST", url: "/api/products", headers: main, payload: { name: "Meal", categoryId: category.json().category.id, pricePaise: 10500, gstRate: 5, kotStationId: null } });
    productId = product.json().product.id;
    const printer = async (name: string) => (await app.inject({ method: "POST", url: "/api/printers", headers: main, payload: { name, kind: "network", connection: "127.0.0.1:9100", paperWidth: 80 } })).json().printer.id as string;
    front = await printer("Front"); back = await printer("Back");
    await setPrinter(front);
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const deviceTwo = async () => (await app.inject({ method: "GET", url: "/api/devices", headers: main })).json().devices.find((d: { name: string }) => d.name === "Two") as { id: string; version: number };
  async function setPrinter(billPrinterId: string | null) {
    const d = await deviceTwo();
    const res = await app.inject({ method: "PATCH", url: `/api/devices/${d.id}/settings`, headers: main, payload: { version: d.version, billPrinterId } });
    expect(res.statusCode).toBe(200);
  }
  async function order(headers: Headers) {
    const res = await app.inject({ method: "POST", url: "/api/orders", headers, payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
    const id = res.json().order.id as string;
    const add = await app.inject({ method: "POST", url: `/api/orders/${id}/items`, headers, payload: { items: [{ productId, qty: 1, clientRef: uuidv7() }] } });
    expect(add.statusCode).toBe(200);
    return id;
  }
  async function billRequest(headers: Headers, orderId: string, extra: Record<string, unknown> = {}) {
    const preview = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers, payload: { discountPaise: 0 } });
    expect(preview.statusCode).toBe(200);
    return { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey as string, ...extra };
  }
  /** Makes an order and issues its bill; `extra` is where a test names a printer, or null for none. */
  const issue = async (headers: Headers, extra: Record<string, unknown> = {}) => {
    const id = await order(headers);
    return app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers, payload: await billRequest(headers, id, extra) });
  };
  const receiptJobs = () => app.printQueue.jobs().filter((j) => j.kind === "receipt");

  describe("issuing a bill", () => {
    it("field absent: the bill prints on the device's printer", async () => {
      const res = await issue(two);
      expect(res.statusCode).toBe(201);
      expect(res.json().job).toMatchObject({ printerId: front, kind: "receipt" });
    });
    it("field absent on a device with no printer, or a browser that is not a device: no print", async () => {
      expect((await issue(main)).json().job).toBeNull();
      const unjoined = await issue(auth(mainToken));
      expect(unjoined.statusCode).toBe(201);
      expect(unjoined.json().job).toBeNull();
      expect(receiptJobs()).toHaveLength(0);
    });
    it("field present: that printer, for this bill only", async () => {
      expect((await issue(two, { printerId: back })).json().job).toMatchObject({ printerId: back });
      expect((await issue(two)).json().job).toMatchObject({ printerId: front });
      expect((await issue(main, { printerId: back })).json().job).toMatchObject({ printerId: back });
    });
    it("null: this bill is not printed", async () => {
      const res = await issue(two, { printerId: null });
      expect(res.statusCode).toBe(201);
      expect(res.json().job).toBeNull();
      expect(receiptJobs()).toHaveLength(0);
    });
    it("a named printer that is not active is refused and no bill is issued", async () => {
      const id = await order(two);
      const res = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: two, payload: await billRequest(two, id, { printerId: "nope" }) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "Choose an active receipt printer" });
      expect((await app.inject({ method: "GET", url: `/api/orders/${id}/bill`, headers: two })).json().bill).toBeNull();
    });
    it("the device's printer switched off: the bill is issued without a print", async () => {
      await app.inject({ method: "PATCH", url: `/api/printers/${front}`, headers: main, payload: { isActive: false } });
      const res = await issue(two);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ job: null, printError: null });
      expect(receiptJobs()).toHaveLength(0);
    });
    it("a replay answers as before and prints nothing more, even after the device's printer changed", async () => {
      const id = await order(two); const body = await billRequest(two, id);
      const send = () => app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: two, payload: body });
      const first = await send();
      expect(first.statusCode).toBe(201);
      await setPrinter(back);
      const replay = await send();
      expect(replay.statusCode).toBe(200);
      expect(replay.json().bill).toEqual(first.json().bill);
      expect(receiptJobs()).toHaveLength(1);
      expect(receiptJobs()[0]).toMatchObject({ printerId: front });
    });
  });

  describe("reprinting a bill", () => {
    const print = (headers: Headers, billId: string, payload?: object) =>
      app.inject({ method: "POST", url: `/api/bills/${billId}/print`, headers, ...(payload ? { payload } : {}) });
    it("uses the device's printer, or the one named", async () => {
      const billId = (await issue(two, { printerId: null })).json().bill.id as string;
      const plain = await print(two, billId);
      expect(plain.statusCode).toBe(202);
      expect(plain.json().job).toMatchObject({ printerId: front });
      expect((await print(two, billId, {})).json().job).toMatchObject({ printerId: front });
      expect((await print(two, billId, { printerId: back })).json().job).toMatchObject({ printerId: back });
      expect((await print(main, billId, { printerId: back })).json().job).toMatchObject({ printerId: back });
    });
    it("refuses when there is nothing to print to", async () => {
      const billId = (await issue(two, { printerId: null })).json().bill.id as string;
      for (const res of [await print(two, billId, { printerId: null }), await print(main, billId), await print(two, billId, { printerId: "nope" })]) {
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: "Choose an active receipt printer" });
      }
      expect(receiptJobs()).toHaveLength(0);
    });
  });

  describe("the quick takeaway path", () => {
    it("issues without a print, then prints the paid bill on the device's printer", async () => {
      const issued = await issue(two, { printerId: null });
      const bill = issued.json().bill as { id: string; totalPaise: number };
      expect(issued.json().job).toBeNull();
      const paid = await app.inject({ method: "POST", url: `/api/bills/${bill.id}/settle`, headers: two, payload: { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: bill.totalPaise }] } });
      expect(paid.statusCode).toBe(200);
      const printed = await app.inject({ method: "POST", url: `/api/bills/${bill.id}/print`, headers: two });
      expect(printed.json().job).toMatchObject({ printerId: front, kind: "receipt" });
      expect(receiptJobs()).toHaveLength(1);
    });
  });

  describe("printing a credit note", () => {
    const print = (headers: Headers, noteId: string, payload?: object) =>
      app.inject({ method: "POST", url: `/api/credit-notes/${noteId}/print`, headers, ...(payload ? { payload } : {}) });
    /** Issues a bill without printing it, voids it, and returns the credit note. */
    const voided = async (headers: Headers) => {
      const billId = (await issue(headers, { printerId: null })).json().bill.id as string;
      const res = await app.inject({ method: "POST", url: `/api/bills/${billId}/void`, headers, payload: { clientRef: uuidv7(), reason: "Wrong order" } });
      expect(res.statusCode).toBe(201);
      return res.json().creditNote.id as string;
    };
    it("uses the device's printer, or the one named", async () => {
      const noteId = await voided(two);
      const plain = await print(two, noteId);
      expect(plain.statusCode).toBe(202);
      expect(plain.json().job).toMatchObject({ printerId: front, kind: "credit_note" });
      expect((await print(two, noteId, { printerId: back })).json().job).toMatchObject({ printerId: back });
    });
    it("refuses when there is nothing to print to", async () => {
      const noteId = await voided(two);
      for (const res of [await print(two, noteId, { printerId: null }), await print(main, noteId), await print(two, noteId, { printerId: "nope" })]) {
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: "Choose an active receipt printer" });
      }
    });
  });
});
