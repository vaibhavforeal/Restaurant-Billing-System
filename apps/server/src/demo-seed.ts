import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

/** Uses normal business APIs. Never call against a restaurant database. */
export async function seedDemo(app: FastifyInstance) {
  const db = app.db;
  const marker = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'demo_meta'").get();
  if (marker) {
    const complete = db.prepare("SELECT complete FROM demo_meta").get() as { complete: number } | undefined;
    if (complete?.complete === 1) return;
    throw new Error("Sample setup was interrupted. Use Demo → Reset sample data to retry.");
  }
  if ((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n) throw new Error("Refusing to seed demo content into an existing restaurant.");
  db.exec("CREATE TABLE demo_meta (complete INTEGER NOT NULL); INSERT INTO demo_meta VALUES (0)");
  let token = "";
  async function request(url: string, payload?: object, method: "POST" | "PUT" = "POST") {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers: { authorization: `Bearer ${token}` } });
    if (response.statusCode >= 400) throw new Error(`Demo setup ${url}: ${response.body}`);
    return response.json();
  }
  token = (await request("/api/setup", { restaurantName: "ForkFlow Demo Restaurant", adminName: "Demo Admin", pin: "1234" })).token;
  await request("/api/users", { name: "Demo Cashier", pin: "2345", role: "cashier" });
  const captain = (await request("/api/users", { name: "Suraj (demo)", pin: "3456", role: "waiter" })).user;
  await request("/api/users", { name: "Demo Kitchen", pin: "4567", role: "kitchen" });
  const station = db.prepare("SELECT id FROM kot_stations ORDER BY id LIMIT 1").get() as { id: string };
  const tables: Array<{ id: string }> = [];
  for (let n = 1; n <= 8; n++) tables.push((await request("/api/tables", { name: `T${String(n).padStart(2, "0")}`, area: n <= 4 ? "Main dining" : "Garden", sortOrder: n })).table);
  const menu = [
    { category: "Starters", dishes: [["Paneer tikka", 22000], ["Crispy corn", 16000], ["Veg kebab", 18000]] },
    { category: "Main course", dishes: [["Vegetable biryani", 24000], ["Paneer butter masala", 26000], ["Dal tadka", 18000], ["Jeera rice", 14000]] },
    { category: "Breads", dishes: [["Butter naan", 4500], ["Garlic naan", 5500], ["Tandoori roti", 3000]] },
    { category: "Drinks & desserts", dishes: [["Masala tea", 4000], ["Sweet lassi", 9000], ["Fresh lime", 7000], ["Gulab jamun", 8000]] },
  ];
  const products: Array<{ id: string; name: string }> = [];
  for (const section of menu) {
    const category = (await request("/api/categories", { name: section.category })).category;
    for (const [name, pricePaise] of section.dishes) products.push((await request("/api/products", { name, pricePaise, categoryId: category.id, gstRate: 5, isVeg: true, kotStationId: station.id })).product);
  }
  const stocks: Array<{ id: string }> = [];
  for (const [name, unit, openingQty, lowStockThreshold] of [["Rice", "kg", 25, 5], ["Oil", "L", 8, 2], ["Paneer", "kg", 6, 2], ["Flour", "kg", 20, 5], ["Milk", "L", 2, 3]] as const) {
    stocks.push((await request("/api/stock-items", { clientRef: randomUUID(), name, unit, openingQty, lowStockThreshold })).item);
  }
  for (const [productIndex, stockIndex, qty] of [[0, 2, .2], [3, 0, .25], [4, 2, .2], [6, 0, .15], [7, 3, .1], [10, 4, .1]] as const) {
    await request(`/api/products/${products[productIndex]!.id}/recipe`, { expectedVersion: 0, ingredients: [{ stockItemId: stocks[stockIndex]!.id, qtyPerSale: qty }, { stockItemId: stocks[1]!.id, qtyPerSale: .01 }] }, "PUT");
  }
  async function order(tableIndex: number | null, index: number) {
    const order = (await request("/api/orders", { clientRef: randomUUID(), type: tableIndex === null ? "parcel" : "dine_in", ...(tableIndex === null ? {} : { tableId: tables[tableIndex]!.id, captainId: captain.id }) })).order;
    await request(`/api/orders/${order.id}/items`, { items: [{ clientRef: randomUUID(), productId: products[index]!.id, qty: 2, note: index === 3 ? "Less spicy" : "" }] });
    const sent = await request(`/api/orders/${order.id}/send`);
    return { order, kots: sent.kots as Array<{ id: string }> };
  }
  for (let i = 0; i < 8; i++) {
    const sample = await order(i % 4, i);
    for (const kot of sample.kots) { await request(`/api/kots/${kot.id}/accept`, {}); await request(`/api/kots/${kot.id}/done`, {}); }
    const preview = (await request(`/api/orders/${sample.order.id}/bill-preview`, { discountPaise: 0 })).preview;
    const bill = (await request(`/api/orders/${sample.order.id}/bill`, { clientRef: randomUUID(), previewKey: preview.previewKey })).bill;
    await request(`/api/bills/${bill.id}/settle`, { clientRef: randomUUID(), payments: [{ mode: ["cash", "card", "upi"][i % 3], amountPaise: bill.totalPaise }] });
  }
  await order(0, 0);
  const accepted = await order(2, 3);
  for (const kot of accepted.kots) await request(`/api/kots/${kot.id}/accept`, {});
  await order(null, 7);
  db.prepare("UPDATE demo_meta SET complete = 1").run();
  db.prepare("DELETE FROM sessions").run();
}
