// Disposable in-memory restaurant for GST returns: no real records or printers.
// Last month: two walk-in bills, a GST invoice to Acme Foods (GSTIN), a bill voided the same month, a walk-in refund and
// a Zomato order. Restaurant GSTIN 29AAPFU0939F1ZR; Zomato's GSTIN 29AAACZ1234A1ZR.
import { freshAppWithFakeSink, setupAdmin, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { uuidv7 } from "@masalapos/domain";

const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
const call = async (method: "POST" | "PUT", url: string, payload: object) => {
  const res = await app.inject({ method, url, payload, headers: auth(admin.token) });
  if (res.statusCode >= 400) throw new Error(`${url}: ${res.body}`); return res.json();
};
await call("PUT", "/api/settings", { restaurantName: "Spice Route", address: "12 MG Road", gstin: "29AAPFU0939F1ZR", zomatoGstin: "29AAACZ1234A1ZR" });
const category = (await call("POST", "/api/categories", { name: "Meals" })).category;
const thali = (await call("POST", "/api/products", { name: "Lunch thali", categoryId: category.id, pricePaise: 26250, gstRate: 5, kotStationId: null })).product;
const water = (await call("POST", "/api/products", { name: "Mineral water", categoryId: category.id, pricePaise: 2000, gstRate: 0, kotStationId: null })).product;

const now = new Date();
const lastMonth = (day: number) => new Date(now.getFullYear(), now.getMonth() - 1, day, 13).getTime();
const ACME = { gstin: "29AAGCB7383J1Z4", name: "Acme Foods Pvt Ltd", address: "Whitefield, Bengaluru" };

async function bill(items: Array<[string, number]>, day: number, buyer?: typeof ACME) {
  const order = (await call("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel", tableId: null })).order;
  await call("POST", `/api/orders/${order.id}/items`, { items: items.map(([productId, qty]) => ({ clientRef: uuidv7(), productId, qty })) });
  const options = buyer ? { buyer } : {};
  const { preview } = await call("POST", `/api/orders/${order.id}/bill-preview`, options);
  const { bill } = await call("POST", `/api/orders/${order.id}/bill`, { ...options, clientRef: uuidv7(), previewKey: preview.previewKey });
  await call("POST", `/api/bills/${bill.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: bill.totalPaise }] });
  app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(lastMonth(day), bill.id);
  app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ?").run(lastMonth(day), bill.id);
  return bill;
}
await bill([[thali.id, 2]], 3);
await bill([[thali.id, 1], [water.id, 2]], 4);
await bill([[thali.id, 4]], 5, ACME);
const voided = await bill([[thali.id, 1]], 6);
const refunded = await bill([[thali.id, 3]], 7);
await call("POST", `/api/bills/${voided.id}/void`, { clientRef: uuidv7(), reason: "Wrong table", refunds: [{ mode: "cash", amountPaise: voided.totalPaise }] });
const itemId = (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(refunded.id) as { id: string }).id;
const lines = [{ orderItemId: itemId, qty: 1 }];
const { preview: credit } = await call("POST", `/api/bills/${refunded.id}/credit-preview`, { kind: "refund", lines });
await call("POST", `/api/bills/${refunded.id}/refund`, { clientRef: uuidv7(), reason: "Cold food", lines, refunds: [{ mode: "cash", amountPaise: credit.totals.totalPaise }] });
// Credit notes are append-only; date them last month as a real clock would have.
app.db.exec("DROP TRIGGER IF EXISTS credit_notes_no_update");
app.db.prepare("UPDATE credit_notes SET created_at = ?").run(lastMonth(8));
// A Zomato order: Zomato pays its GST (section 9(5)); written directly, as the Zomato desk needs the Zomato integration.
const zomato = await bill([[thali.id, 2]], 9);
app.db.prepare("UPDATE orders SET type = 'zomato', zomato_order_id = 'ZOM-1001', zomato_status = 'picked_up', price_tier = 'zomato' WHERE id = ?").run(zomato.orderId);
app.db.prepare("UPDATE bills SET receipt_json = json_set(receipt_json, '$.gstMode', 'none', '$.gstPaidBy', 'zomato', '$.orderType', 'zomato') WHERE id = ?").run(zomato.id);

await app.listen({ host: "127.0.0.1", port: 4164 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("GST returns fixture: http://127.0.0.1:4164 · admin / admin-password");
