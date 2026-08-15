import { afterEach, describe, expect, it } from "vitest";
import { auth, freshAppWithFakeSink, setupAdmin, wsAuth } from "./test-helpers.js";

let app: ReturnType<typeof freshAppWithFakeSink>["app"];
afterEach(async () => {
  await app?.close();
});

describe("printers API", () => {
  it("creates and lists printers", async () => {
    const { app: testApp } = freshAppWithFakeSink();
    app = testApp;
    const admin = await setupAdmin(app);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/printers",
      payload: { name: "Front Counter", kind: "network", connection: "192.168.1.50", paperWidth: 80 },
      headers: auth(admin.token),
    });
    expect(createRes.statusCode).toBe(201);
    const printer = createRes.json().printer;
    expect(printer.name).toBe("Front Counter");
    expect(printer.kind).toBe("network");

    const listRes = await app.inject({ method: "GET", url: "/api/printers", headers: auth(admin.token) });
    expect(listRes.json().printers).toHaveLength(1);
  });

  it("updates printer", async () => {
    const { app: testApp } = freshAppWithFakeSink();
    app = testApp;
    const admin = await setupAdmin(app);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/printers",
      payload: { name: "Printer 1", kind: "network", connection: "192.168.1.1" },
      headers: auth(admin.token),
    });
    const printerId = createRes.json().printer.id;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/printers/${printerId}`,
      payload: { name: "Updated Printer", isActive: false },
      headers: auth(admin.token),
    });
    expect(patchRes.statusCode).toBe(200);
    const updated = patchRes.json().printer;
    expect(updated.name).toBe("Updated Printer");
    expect(updated.isActive).toBe(false);
  });

  it("test-print enqueues a job", async () => {
    const { app: testApp, fake } = freshAppWithFakeSink();
    app = testApp;
    const admin = await setupAdmin(app);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/printers",
      payload: { name: "Test Printer", kind: "network", connection: "192.168.1.1" },
      headers: auth(admin.token),
    });
    const printerId = createRes.json().printer.id;

    const testRes = await app.inject({
      method: "POST",
      url: `/api/printers/${printerId}/test-print`,
      headers: auth(admin.token),
    });
    expect(testRes.statusCode).toBe(202);
    const job = testRes.json().job;
    expect(job.kind).toBe("test");
    expect(job.status).toBe("queued");

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fake.sent).toHaveLength(1);
    const bytes = fake.sent[0]!.bytes;
    expect(bytes.includes(Buffer.from("TEST PRINT"))).toBe(true);
  });

  it("lists and retries print jobs", async () => {
    const { app: testApp, fake } = freshAppWithFakeSink();
    app = testApp;
    const admin = await setupAdmin(app);
    fake.failNext("printer offline");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/printers",
      payload: { name: "Printer", kind: "network", connection: "test" },
      headers: auth(admin.token),
    });
    const printerId = createRes.json().printer.id;

    await app.inject({
      method: "POST",
      url: `/api/printers/${printerId}/test-print`,
      headers: auth(admin.token),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const jobsRes = await app.inject({ method: "GET", url: "/api/print-jobs", headers: auth(admin.token) });
    const jobs = jobsRes.json().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("failed");

    const retryRes = await app.inject({
      method: "POST",
      url: `/api/print-jobs/${jobs[0].id}/retry`,
      headers: auth(admin.token),
    });
    expect(retryRes.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const finalJobs = await app.inject({ method: "GET", url: "/api/print-jobs", headers: auth(admin.token) });
    expect(finalJobs.json().jobs[0].status).toBe("done");
  });
});

describe("stations CRUD", () => {
  it("creates station with printer assignment", async () => {
    const { app: testApp } = freshAppWithFakeSink();
    app = testApp;
    const admin = await setupAdmin(app);

    const printerRes = await app.inject({
      method: "POST",
      url: "/api/printers",
      payload: { name: "KOT Printer", kind: "network", connection: "192.168.1.1" },
      headers: auth(admin.token),
    });
    const printerId = printerRes.json().printer.id;

    const stationRes = await app.inject({
      method: "POST",
      url: "/api/kot-stations",
      payload: { name: "Grill", printerId },
      headers: auth(admin.token),
    });
    expect(stationRes.statusCode).toBe(201);
    const station = stationRes.json().station;
    expect(station.name).toBe("Grill");
    expect(station.printerId).toBe(printerId);
  });

  it("rejects unknown printer in station create", async () => {
    const { app: testApp } = freshAppWithFakeSink();
    app = testApp;
    const admin = await setupAdmin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/kot-stations",
      payload: { name: "Bar", printerId: "unknown-id" },
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown printer");
  });

  it("updates station printer assignment", async () => {
    const { app: testApp } = freshAppWithFakeSink();
    app = testApp;
    const admin = await setupAdmin(app);

    const stationsRes = await app.inject({ method: "GET", url: "/api/kot-stations", headers: auth(admin.token) });
    const kitchenStation = stationsRes.json().stations[0];

    const printerRes = await app.inject({
      method: "POST",
      url: "/api/printers",
      payload: { name: "New Printer", kind: "network", connection: "192.168.1.2" },
      headers: auth(admin.token),
    });
    const printerId = printerRes.json().printer.id;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/kot-stations/${kitchenStation.id}`,
      payload: { printerId },
      headers: auth(admin.token),
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().station.printerId).toBe(printerId);
  });
});

describe("KOT printing integration", () => {
  it("enqueues KOT slip on send-to-kitchen", async () => {
    const { app: testApp, fake } = freshAppWithFakeSink();
    app = testApp;
    const admin = await setupAdmin(app);

    // Create printer and assign to Kitchen station
    const printerRes = await app.inject({
      method: "POST",
      url: "/api/printers",
      payload: { name: "KOT Printer", kind: "network", connection: "192.168.1.1", paperWidth: 80 },
      headers: auth(admin.token),
    });
    const printerId = printerRes.json().printer.id;

    const stationsRes = await app.inject({ method: "GET", url: "/api/kot-stations", headers: auth(admin.token) });
    const kitchenId = stationsRes.json().stations[0].id;

    await app.inject({
      method: "PATCH",
      url: `/api/kot-stations/${kitchenId}`,
      payload: { printerId },
      headers: auth(admin.token),
    });

    // Create product and order
    const catRes = await app.inject({
      method: "POST",
      url: "/api/categories",
      payload: { name: "Mains" },
      headers: auth(admin.token),
    });
    const categoryId = catRes.json().category.id;

    const productRes = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { categoryId, name: "Biryani", pricePaise: 30000, gstRate: 5, kotStationId: kitchenId },
      headers: auth(admin.token),
    });
    const productId = productRes.json().product.id;

    const orderRes = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { clientRef: "test-kot-print", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId, qty: 2 }] },
      headers: auth(admin.token),
    });

    await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fake.sent).toHaveLength(1);
    const bytes = fake.sent[0]!.bytes;
    const str = bytes.toString();
    expect(str).toContain("KOT #");
    expect(str).toContain("2 x Biryani");
  });

  it("enqueues cancel slip on sent item cancellation", async () => {
    const { app: testApp, fake } = freshAppWithFakeSink();
    app = testApp;
    const admin = await setupAdmin(app);

    // Setup printer + station
    const printerRes = await app.inject({
      method: "POST",
      url: "/api/printers",
      payload: { name: "KOT Printer", kind: "network", connection: "192.168.1.1" },
      headers: auth(admin.token),
    });
    const printerId = printerRes.json().printer.id;

    const stationsRes = await app.inject({ method: "GET", url: "/api/kot-stations", headers: auth(admin.token) });
    const kitchenId = stationsRes.json().stations[0].id;

    await app.inject({
      method: "PATCH",
      url: `/api/kot-stations/${kitchenId}`,
      payload: { printerId },
      headers: auth(admin.token),
    });

    // Create and send order
    const catRes = await app.inject({
      method: "POST",
      url: "/api/categories",
      payload: { name: "Mains" },
      headers: auth(admin.token),
    });
    const categoryId = catRes.json().category.id;

    const productRes = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { categoryId, name: "Dal", pricePaise: 12000, gstRate: 5, kotStationId: kitchenId },
      headers: auth(admin.token),
    });
    const productId = productRes.json().product.id;

    const orderRes = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { clientRef: "test-cancel-print", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const sendRes = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });
    const itemId = sendRes.json().order.items[0].id;

    await new Promise((resolve) => setTimeout(resolve, 10));
    fake.sent.length = 0; // Clear KOT print

    // Cancel the sent item
    await app.inject({
      method: "POST",
      url: `/api/order-items/${itemId}/cancel`,
      payload: { reason: "Customer request" },
      headers: auth(admin.token),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fake.sent).toHaveLength(1);
    const bytes = fake.sent[0]!.bytes;
    const str = bytes.toString();
    expect(str).toContain("CANCELLED");
    expect(str).toContain("1 x Dal");
    expect(str).toContain("Customer request");
  });
});

describe("WS print.job broadcast", () => {
  it("broadcasts print.job on status changes", async () => {
    const { app: testApp } = freshAppWithFakeSink();
    app = testApp;
    const admin = await setupAdmin(app);

    const printerRes = await app.inject({
      method: "POST",
      url: "/api/printers",
      payload: { name: "Printer", kind: "network", connection: "test" },
      headers: auth(admin.token),
    });
    const printerId = printerRes.json().printer.id;

    const ws = await wsAuth(app, admin.token);
    const messages: Array<{ event?: string; data?: { job?: { status: string } } }> = [];
    ws.on("message", (raw: Buffer) => { messages.push(JSON.parse(raw.toString())); });

    await app.inject({
      method: "POST",
      url: `/api/printers/${printerId}/test-print`,
      headers: auth(admin.token),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const jobEvents = messages.filter((m) => m.event === "print.job");
    expect(jobEvents.length).toBeGreaterThan(0);
    expect(jobEvents.some((e) => e.data?.job?.status === "queued")).toBe(true);

    ws.close();
  });
});
