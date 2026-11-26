
import { randomBytes } from "node:crypto";
import { mock } from "node:test";
import { MIGRATIONS, localDateKey, migrate, openDb, type Bill, type Database } from "@masalapos/domain";
import { DASHBOARD_WIDGETS, type DashboardLayoutValue } from "@masalapos/domain/dashboard";
import { buildServer } from "./server.js";
import { makeFakeSink } from "./print/sinks.js";
import { sweepAllExpiry } from "./loyalty.js";
import { loadBillCredit } from "./credit-notes.js";
import { buildSampleFixtures, dayAt, ref, SAMPLE_PIN, type Id, type Request, type SampleFixtures } from "./sample-fixtures.js";

const PAST_DAYS = 395;
type OrderItem = { productId: string; variantId?: string; qty: number; note?: string; held?: boolean; comboPicks?: string[]; addonPicks?: string[] };
type Order = Id & { items: Array<Id & { qty: number; status: string }> };
type Drawer = Id & { expectedCashPaise: number; handover: { seq: number } | null };

async function addItems(call: Request, order: Id, items: OrderItem[]) {
  return (await call<{ order: Order }>(`/api/orders/${order.id}/items`, { items: items.map(item => ({ ...item, clientRef: ref() })) })).order;
}

async function openOrder(call: Request, body: object) {
  return (await call<{ order: Order }>("/api/orders", { ...body, clientRef: ref() })).order;
}

async function send(call: Request, order: Id) {
  return (await call<{ kots: Id[] }>(`/api/orders/${order.id}/send`)).kots;
}

async function issue(call: Request, order: Id, options: object = {}) {
  const { preview } = await call<{ preview: { previewKey: string } }>(`/api/orders/${order.id}/bill-preview`, options);
  return (await call<{ bill: Bill }>(`/api/orders/${order.id}/bill`, { ...options, clientRef: ref(), previewKey: preview.previewKey })).bill;
}

async function drawer(call: Request, drawerId: string, openingFloatPaise: number) {
  return (await call<{ shift: Drawer }>("/api/shifts", { drawerId, openingFloatPaise, clientRef: ref() })).shift;
}

async function closeDrawer(call: Request, fixtures: SampleFixtures, shortage: number) {
  const { admin, adminId } = fixtures;
  const current = async () => (await call<{ shift: Drawer }>("/api/shifts/current", undefined, "GET")).shift;
  const shift = await current();
  const counted = shift.expectedCashPaise - shortage;
  const handover = (request: Request, revision: number, change: object) => request(`/api/shifts/${shift.id}/handover`, { clientRef: ref(), revision, change });
  await handover(call, 0, { action: "submit", recipient: adminId, final: true, counted, note: shortage ? "Short in closing count" : "End of shift" });
  if (shortage) await handover(admin, (await current()).handover!.seq, { action: "approve" });
  await handover(admin, (await current()).handover!.seq, { action: "receive", received: counted });
}

function sampleDish(f: SampleFixtures, name: string, qty = 1): OrderItem {
  const product = f.byName.get(name)!;
  const variantId = product.variants[0]?.id;
  return { productId: product.id, ...(variantId ? { variantId } : {}), qty };
}

async function purchase(db: Database, f: SampleFixtures, name: string, quantity: number, costPaise: number) {
  const stock = f.stocks.get(name)!;
  const current = db.prepare("SELECT version FROM stock_items WHERE id=?").get(stock.id) as { version: number };
  await f.admin(`/api/stock-items/${stock.id}/movements`, { clientRef: ref(), expectedVersion: current.version,
    reason: "purchase", quantity, costPaise, note: "Regional Foods wholesale delivery" });
}

async function adjustStock(db: Database, f: SampleFixtures, name: string, reason: "adjustment" | "wastage", quantity: number, note: string) {
  const stock = f.stocks.get(name)!;
  const current = db.prepare("SELECT version, qty FROM stock_items WHERE id=?").get(stock.id) as { version: number; qty: number };
  if (reason !== "adjustment" || current.qty !== quantity) await f.admin(`/api/stock-items/${stock.id}/movements`, {
    clientRef: ref(), expectedVersion: current.version, reason, quantity, note,
  });
}

interface ZomatoSale { id: string; total: number; date: string }
function trading(db: Database, f: SampleFixtures, setTime: (time: number) => void) {
  const captain = f.staff.get("captain")!;
  const kitchen = f.staff.get("kitchen")!.request;
  const market: ZomatoSale[] = [];
  const dishes = f.products.filter(p => !f.unavailable.includes(p));
  const favourites = ["Masala dosa", "Chole bhature", "Paneer butter masala", "Hyderabadi chicken biryani", "Pav bhaji", "Dal tadka"];
  const accompaniments = ["Butter naan", "Tandoori roti", "Jeera rice", "Mango lassi", "Gulab jamun", "South Indian filter coffee"];
  const notes = ["Less spicy", "No onions", "Serve together", "Chutney on the side"];
  const payments = ["cash", "upi", "upi", "card"] as const;
  const select = (index: number) => dishes[index % dishes.length]!;
  const paymentModes = (index: number, amountPaise: number) => index % 17 === 1 && amountPaise > 100
    ? [{ mode: "cash", amountPaise: Math.floor(amountPaise / 2), refNote: "Sample cash portion" },
       { mode: "upi", amountPaise: Math.ceil(amountPaise / 2), refNote: `SAMPLE-UPI-${index}` }]
    : [{ mode: payments[index % payments.length], amountPaise, refNote: index % 4 === 0 ? "" : `SAMPLE-${index}` }];

  async function sale(call: Request, index: number, time: number, finishBy = Infinity) {
    setTime(time);
    const zomato = index % 29 === 13, parcel = index % 4 === 1 || index % 7 === 0;
    const externalId = `SAMPLE-${String(index).padStart(5, "0")}`;
    const order = await openOrder(zomato ? f.admin : call, zomato ? { type: "zomato", zomatoOrderId: externalId }
      : parcel ? { type: "parcel", orderTypeId: index % 3 === 0 ? f.delivery.id : f.pickup.id }
      : { type: "dine_in", tableId: f.tables[index % 18]!.id, captainId: index % 2 ? captain.user.id : f.staff.get("captain2")!.user.id, guestCount: 1 + index % 7 });
    const canRefund = !zomato && index % 61 === 7;
    const customerIndex = index % 13 === 1 ? index % f.customers.length
      : index % 23 === 2 ? (Math.floor(index / 23) % 22) * 23
      : index % 3 === 0 ? index % 49 : (index * 79) % Math.min(500, f.customers.length);
    const customer = !zomato && index % 11 !== 0 ? f.customers[customerIndex]! : undefined;
    if (customer) await call(`/api/orders/${order.id}/customer`, { customerId: customer.id }, "PATCH");

    const first = select(index * 73), second = select(index * 29 + 17);
    const regularItems: OrderItem[] = [
      { ...(index % 3 === 0 ? sampleDish(f, favourites[index % favourites.length]!, 2) : { productId: first.id,
        ...(first.variants[1] ? { variantId: first.variants[1].id } : {}), qty: index % 5 === 0 ? 2 : 1 }),
        ...(index % 9 === 0 ? { note: notes[index % notes.length] } : {}) },
      index % 3 === 0 ? sampleDish(f, accompaniments[Math.floor(index / 3) % accompaniments.length]!, 2)
        : { productId: second.id, qty: 1 },
    ];
    if (index % 11 === 0) regularItems.push(sampleDish(f, accompaniments[(index + 1) % accompaniments.length]!, 2));
    if (!zomato && index % 24 === 2) regularItems.push({ productId: f.combo.id, qty: 1, comboPicks: f.comboPicks });
    if (index % 19 === 3) regularItems.push({ ...sampleDish(f, "Masala dosa"), addonPicks: f.addonPicks, note: "Extra crisp" });
    if (parcel && index % 13 === 5) regularItems.push(sampleDish(f, "Mango lassi", 2));
    const sentOrder = await addItems(call, order, regularItems);
    const kots = await send(call, order);
    if (!zomato && index % 89 === 20) {
      const item = sentOrder.items[0]!;
      await call(`/api/order-items/${item.id}/edit-sent`, { clientRef: ref(), note: "No extra chilli", ...(item.qty > 1 ? { qty: item.qty - 1 } : {}), reason: "Guest updated their order", print: false });
    }
    setTime(Math.min(finishBy, time + (3 + index % 12) * 12_000));
    for (const kot of kots) await kitchen(`/api/kots/${kot.id}/done`, {});

    if (zomato) {
      await call(`/api/orders/${order.id}/zomato-status`, { status: "ready", clientRef: ref() });
      const { bill } = await call<{ bill: Bill }>(`/api/orders/${order.id}/zomato-status`, { status: "picked_up", clientRef: ref() });
      market.push({ id: externalId, total: bill.totalPaise, date: localDateKey(time) });
      return;
    }
    const discount = index % 71 === 5 ? { discountPaise: 7000, discountNote: "Service recovery sample", approverPin: SAMPLE_PIN } : {};
    const buyer = customer?.gstin && customer.legalName ? { buyer: { gstin: customer.gstin, name: customer.legalName, address: "Sample Business Park, Bengaluru" } } : {};
    let redeemPoints = 0;
    if (customer && index % 31 === 4 && !canRefund) {
      const balance = db.prepare("SELECT COALESCE(SUM(points),0) AS n FROM loyalty_ledger WHERE customer_id=?").get(customer.id) as { n: number };
      if (balance.n >= 20) redeemPoints = 20;
    }
    const bill = await issue(call, order, { ...buyer, ...discount, redeemPoints, serviceCharge: index % 11 !== 6 });
    const tender = canRefund ? [{ mode: payments[index % payments.length]!, amountPaise: bill.totalPaise }] : paymentModes(index, bill.totalPaise);
    await call(`/api/bills/${bill.id}/settle`, { clientRef: ref(), payments: tender });
    if (canRefund) {
      const kind = index % 3 === 0 ? "void" : "refund";
      const billed = loadBillCredit(db, bill.id).lines;
      const lines = index % 3 === 1 ? billed.filter(item => item.totalPaise > 0).slice(0, 1).map(({ orderItemId }) => ({ orderItemId, qty: 1 }))
        : billed.map(({ orderItemId, qty }) => ({ orderItemId, qty }));
      const opts = kind === "refund" ? { lines } : {};
      const { preview } = await call<{ preview: { totals: { totalPaise: number } } }>(`/api/bills/${bill.id}/credit-preview`, { kind, ...opts });
      await call(`/api/bills/${bill.id}/${kind}`, { ...opts, clientRef: ref(), approverPin: SAMPLE_PIN, reason: "Guest returned a dish · sample",
        refunds: [{ mode: tender[0]!.mode, amountPaise: preview.totals.totalPaise, refNote: "Sample refund" }] });
    }
    if (index % 13 === 2 && !canRefund) {
      const rating = 2 + index % 4;
      const payload = { overall: rating, food: Math.min(5, rating + 1), service: rating, ambience: 4,
        comment: ["Loved the regional specials", "A little slow at dinner", "Great dosas and friendly staff", "Would order the thali again"][index % 4] };
      const token = (db.prepare("SELECT feedback_token FROM bills WHERE id=?").get(bill.id) as { feedback_token: string | null }).feedback_token;
      if (index % 2 === 0 && token) await call(`/api/guest/feedback/${token}`, payload);
      else await call(`/api/bills/${bill.id}/feedback`, payload);
    }
  }
  return { market, sale };
}

async function seedHistory(db: Database, f: SampleFixtures, anchor: number, setTime: (time: number) => void, progress: () => void) {
  const { sale, market } = trading(db, f, setTime);
  const cashiers = ["cashier", "cashier2"].map(name => f.staff.get(name)!.request);
  const weights = Array.from({ length: PAST_DAYS }, (_, i) => {
    const day = new Date(dayAt(anchor, i - PAST_DAYS)).getDay();
    return day === 0 || day === 6 ? 12 : day === 5 ? 9 : 6;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const recentCount = 10;
  let cumulative = 0, sequence = 0;
  const refreshSessions = db.prepare("UPDATE sessions SET expires_at = ?");
  for (const [i, weight] of weights.entries()) {
    if (i % 25 === 0) progress();
    const offset = i - PAST_DAYS;
    const morning = dayAt(anchor, offset, 8);
    setTime(morning);
    refreshSessions.run(dayAt(anchor, offset + 2));
    const cashier = cashiers[i % cashiers.length]!;
    const shift = await drawer(cashier, "main", 250000);
    if (i % 20 === 0) {
      await cashier(`/api/shifts/${shift.id}/cash-movements`, { clientRef: ref(), kind: "pay_in", amountPaise: 20000, reason: "Small change from office" });
      await cashier(`/api/shifts/${shift.id}/cash-movements`, { clientRef: ref(), kind: "pay_out", amountPaise: 17000, reason: "Vegetable market petty cash" });
    }
    if (i % 14 === 0) {
      for (const [name, quantity, amount] of [
        ["Basmati rice", 35, 490000], ["Mixed vegetables", 55, 350000], ["Onions", 18, 100000],
        ["Wheat flour", 28, 155000], ["Milk", 30, 210000], ["Curd", 23, 202400], ["Paneer", 13, 580000],
        ["Spice blend", 4, 161000], ["Chicken", 10, 270000], ["Fish", 5, 330000], ["Cooking oil", 8, 145000],
      ] as const) await purchase(db, f, name, quantity, amount + i * 50);
    }
    if (i % 32 === 0) {
      await adjustStock(db, f, "Mixed vegetables", "wastage", .85, "Trim and spoilage");
      await adjustStock(db, f, "Coriander", "adjustment", i % 64 === 0 ? 1.75 : 2.25, "Counted at opening");
      sweepAllExpiry(db, morning);
    }
    cumulative += weight;
    const end = Math.floor(cumulative * (3000 - recentCount) / totalWeight);
    const count = end - sequence;
    for (let j = 0; j < count; j++) {
      const hour = j === 0 ? 9 : j <= count / 2 ? 12 : 19;
      const time = dayAt(anchor, offset, hour) + j * 240_000;
      await sale(cashier, sequence++, time);
    }
    setTime(dayAt(anchor, offset, 23));
    if (i % 12 === 0) {
      const order = await openOrder(cashier, { type: "dine_in", tableId: f.tables[7]!.id, guestCount: 2 });
      const withItem = await addItems(cashier, order, [sampleDish(f, "Paneer butter masala", 2)]);
      const tickets = await send(cashier, order);
      const item = withItem.items[0]!;
      await cashier(`/api/order-items/${item.id}/cancel`, { reason: "Guest changed their main" });
      for (const kot of tickets) await f.staff.get("kitchen")!.request(`/api/kots/${kot.id}/done`, {});
      await cashier(`/api/orders/${order.id}/cancel`, { reason: "Guest left before service" });
    }
    await closeDrawer(cashier, f, i % 28 === 19 ? 6500 : 0);
    if (i % 3 !== 2) await f.admin("/api/day-close", { clientRef: ref(), date: localDateKey(morning), note: "Sample end-of-day close" });
  }

  const today = dayAt(anchor, 0);
  const start = Math.max(today, anchor - 2 * 3600_000);
  setTime(start);
  refreshSessions.run(dayAt(anchor, 2));
  await f.addRecentCustomers();
  await drawer(cashiers[0]!, "main", 175000);
  await drawer(cashiers[1]!, f.sideDrawer, 125000);
  // The last sale is dated today even if setup is run just after midnight.
  for (let i = 0; i < recentCount; i++) {
    const time = start + Math.floor(i * (anchor - start) / recentCount);
    await sale(cashiers[0]!, sequence++, time, anchor);
  }
  setTime(anchor);
  sweepAllExpiry(db, anchor);
  return market;
}

async function buildReports(f: SampleFixtures, market: ZomatoSale[], anchor: number) {
  const { admin } = f;
  for (const [source, name, fields] of [
    ["bills", "Sales by order type", ["orderType", "bills", "discount", "gst", "total"]],
    ["bill_items", "Dishes by category", ["category", "lines", "qty", "total"]],
    ["payments", "Collections by payment method", ["mode", "payments", "amount"]],
    ["customers", "Guest visits and spend", ["type", "visits", "spend", "pointsBalance"]],
    ["loyalty", "Loyalty movement", ["entry", "entries", "points"]],
    ["feedback", "Ratings by channel", ["source", "responses", "overall", "food", "service", "ambience"]],
  ] as const) await admin("/api/custom-reports", { name, config: { source, columns: fields.map(field => ({ field })), groupBy: [fields[0]] } });
  const { layout } = await admin<{ layout: DashboardLayoutValue }>("/api/dashboard/layout", undefined, "GET");
  const present = new Set(layout.items.map(item => item.widget));
  let x = 0, y = Math.max(...layout.items.map(item => item.y + item.h));
  for (const widget of DASHBOARD_WIDGETS.filter(def => !present.has(def.id))) {
    const { w, h } = widget.defaultSize;
    if (x + w > 12) { x = 0; y += 4; }
    layout.items.push({ key: widget.id, widget: widget.id, x, y, w, h,
      options: { period: "thisWeek", compare: "previous", orderType: "all", topN: 8 } });
    x += w;
  }
  await admin("/api/dashboard/layout", { layout }, "PUT");
  const settings = await admin<{ version: number }>("/api/zomato/settings", undefined, "GET");
  const restaurantId = "SAMPLE-BENGALURU";
  await admin("/api/zomato/settings", { restaurantId, restaurantName: "The Indian Table",
    posId: "SAMPLE-POS", webhookBaseUrl: "", enabled: false, version: settings.version }, "PATCH");
  const importCsv = async (kind: "orders" | "settlements", csv: string) => {
    const { revision } = await admin<{ revision: string }>("/api/zomato/import/preview", { kind, csv });
    await admin("/api/zomato/import/commit", { kind, csv, revision });
  };
  const local = localDateKey(anchor);
  await importCsv("orders", [
    "restaurant_id,order_id,ordered_at,status,payment_mode,order_total",
    `${restaurantId},SAMPLE-CANCELLED,${new Date(dayAt(anchor, -2, 12)).toISOString()},cancelled,prepaid,395.00`,
    `${restaurantId},SAMPLE-INBOX,${new Date(anchor).toISOString()},confirmed,prepaid,475.00`,
    `${restaurantId},SAMPLE-UNPAID,${new Date(dayAt(anchor, -3, 12)).toISOString()},delivered,prepaid,345.00`,
  ].join("\n"));
  const statement = (id: string, total: number, date: string, index: number, discrepancy = false) => {
    const fee = Math.round(total * .18), add = index % 5 === 0 ? 1000 : 0;
    const money = (paise: number) => (paise / 100).toFixed(2);
    return `${restaurantId},ENTRY-${index},${id},STATEMENT-${date},${date},${money(total)},${money(fee)},${money(add)},${money(total - fee + add - (discrepancy ? 2000 : 0))}`;
  };
  await importCsv("settlements", [
    "restaurant_id,entry_id,order_id,settlement_reference,settlement_date,gross_amount,deductions,additions,net_paid",
    ...market.filter((_, i) => i % 7 !== 2).map((entry, i) => statement(entry.id, entry.total, entry.date, i, i % 11 === 7)),
    statement("SAMPLE-CANCELLED", 39500, local, market.length + 1),
    statement("SAMPLE-ORPHAN", 65000, local, market.length + 2),
  ].join("\n"));
}

async function seedLive(db: Database, f: SampleFixtures, fake: ReturnType<typeof makeFakeSink>, anchor: number, setTime: (time: number) => void) {
  const { admin, tables, staff } = f;
  const captain = staff.get("captain")!;
  const dine = (table: number, guestCount: number) => openOrder(captain.request, { type: "dine_in", tableId: tables[table]!.id, captainId: captain.user.id, guestCount });
  const { printer } = await admin<{ printer: Id }>("/api/printers", { name: "Sample Counter 80 mm", kind: "network", connection: "counter.invalid",
    paperWidth: 80, receiptProfile: { copies: 1, feedLines: 4 }, kotProfile: { copies: 1, feedLines: 2 } });
  const { printer: kitchen } = await admin<{ printer: Id }>("/api/printers", { name: "Sample Kitchen 58 mm", kind: "network", connection: "kitchen.invalid",
    paperWidth: 58, kotProfile: { copies: 2, feedLines: 2, autoCut: false } });
  for (const station of f.stations.values()) await admin(`/api/kot-stations/${station.id}`, { printerId: kitchen.id }, "PATCH");
  const first = await dine(0, 4);
  await addItems(captain.request, first, [
    { ...sampleDish(f, "Masala dosa", 2), addonPicks: f.addonPicks, note: "Serve one without onions" },
    { ...sampleDish(f, "Rasmalai", 2), held: true }, sampleDish(f, "Mango lassi", 2),
  ]);
  await send(captain.request, first);
  const second = await dine(1, 2);
  await addItems(captain.request, second, [sampleDish(f, "Khaman dhokla"), sampleDish(f, "Pav bhaji", 2)]);
  await send(captain.request, second);
  await captain.request(`/api/orders/${second.id}/move`, { clientRef: ref(), tableId: tables[3]!.id });
  const split = await dine(3, 2);
  const withSplit = await addItems(captain.request, split, [sampleDish(f, "Chole bhature", 2), sampleDish(f, "Goan fish curry")]);
  await captain.request(`/api/orders/${split.id}/transfer-items`, { clientRef: ref(), targetOrderId: second.id, items: [{ id: withSplit.items[0]!.id, qty: withSplit.items[0]!.qty }] });
  const joined = await dine(2, 2);
  await addItems(captain.request, joined, [sampleDish(f, "Dal tadka"), sampleDish(f, "Jeera rice", 2)]);
  await captain.request(`/api/orders/${joined.id}/merge`, { clientRef: ref(), targetOrderId: first.id });
  const invoiceOrder = await dine(4, 5);
  await addItems(captain.request, invoiceOrder, [{ productId: f.combo.id, qty: 2, comboPicks: f.comboPicks }]);
  const invoiceKots = await send(captain.request, invoiceOrder);
  for (const kot of invoiceKots) await staff.get("kitchen")!.request(`/api/kots/${kot.id}/done`, {});
  const invoice = await issue(admin, invoiceOrder);
  fake.failNext("Simulated printer is out of paper");
  await admin(`/api/bills/${invoice.id}/print`, { printerId: printer.id });
  await admin(`/api/bills/${invoice.id}/print`, { printerId: printer.id });
  const held = await openOrder(admin, { type: "parcel", orderTypeId: f.pickup.id });
  await addItems(admin, held, [{ ...sampleDish(f, "Pav bhaji", 2), held: true }, sampleDish(f, "Mango lassi")]);
  const delivery = await openOrder(admin, { type: "parcel", orderTypeId: f.delivery.id });
  await addItems(admin, delivery, [sampleDish(f, "Hyderabadi chicken biryani", 2), sampleDish(f, "Gulab jamun", 2)]);
  await send(admin, delivery);
  const aggregator = await openOrder(admin, { type: "zomato", zomatoOrderId: "SAMPLE-AT-COUNTER" });
  await addItems(admin, aggregator, [sampleDish(f, "Hyderabadi chicken biryani"), sampleDish(f, "Mango lassi")]);
  await send(admin, aggregator);
  await admin(`/api/orders/${aggregator.id}/zomato-status`, { status: "ready", clientRef: ref() });

  const reserve = async (tableIndex: number, start: number, partySize: number, notes: string) => {
    const customer = f.customers[540 + tableIndex]!;
    const time = new Date(start).toTimeString().slice(0, 5);
    return (await admin<{ reservation: Id & { version: number } }>("/api/reservations", {
      clientRef: ref(), tableId: tables[tableIndex]!.id, customerName: customer.name, phone: customer.phone,
      partySize, startsLocal: `${localDateKey(start)}T${time}`, durationMinutes: 90, notes,
    })).reservation;
  };
  await reserve(13, anchor + 75 * 60_000, 4, "Family dinner");
  await reserve(16, dayAt(anchor, 1, 12), 6, "Quiet table for lunch");
  const cancelled = await reserve(17, anchor + 60 * 60_000, 4, "Outdoor seating if available");
  await admin(`/api/reservations/${cancelled.id}/status`, { version: cancelled.version, status: "cancelled" });
  const bookedAt = anchor - 50 * 60_000;
  setTime(bookedAt);
  const noShow = await reserve(15, bookedAt + 10 * 60_000, 3, "Anniversary booking");
  const seated = await reserve(14, anchor + 10 * 60_000, 2, "Window table");
  setTime(anchor);
  await admin(`/api/reservations/${noShow.id}/status`, { version: noShow.version, status: "no_show" });
  const { order: seatedOrder } = await admin<{ order: Order }>(`/api/reservations/${seated.id}/seat`, { version: seated.version });
  await addItems(captain.request, seatedOrder, [sampleDish(f, "Chole bhature"), sampleDish(f, "Masala chai", 2)]);
  await send(captain.request, seatedOrder);

  const submitGuest = async (table: number, service?: "waiter" | "bill") => {
    const { table: qr } = await admin<{ table: { path: string } }>(`/api/qr/tables/${tables[table]!.id}`, { enabled: true }, "PUT");
    const token = qr.path.split("#")[1]!;
    const headers = { "x-qr-token": token };
    const data = { clientRef: ref(), receiptToken: randomBytes(32).toString("hex") };
    if (service) return (await admin<{ request: Id }>("/api/guest/service-requests", { ...data, kind: service }, "POST", headers)).request;
    const menu = await admin<{ menuVersion: string }>("/api/guest/menu", undefined, "GET", headers);
    const item = sampleDish(f, "Khaman dhokla", 2);
    return (await admin<{ request: Id }>("/api/guest/requests", { ...data, menuVersion: menu.menuVersion,
      items: [{ ...item, variantId: item.variantId ?? null, note: "Extra chutney if available" }] }, "POST", headers)).request;
  };
  setTime(anchor - 4 * 3600_000);
  await submitGuest(0, "waiter");
  await submitGuest(0);
  setTime(anchor);
  await submitGuest(0);
  const accepted = await submitGuest(1);
  await admin(`/api/qr/requests/${accepted.id}/accept`, { orderId: null });
  const rejected = await submitGuest(3);
  await admin(`/api/qr/requests/${rejected.id}/reject`, { reason: "Guest placed the same order with the captain" });
  const waiter = await submitGuest(0, "waiter");
  await admin(`/api/qr/service-requests/${waiter.id}/resolve`, {});
  await submitGuest(4, "bill");

  for (const [i, product] of f.unavailable.entries()) {
    await admin(`/api/products/${product.id}`, i % 4 === 3 ? { isActive: false } : { isSoldOut: true }, "PATCH");
    if (i % 2 === 0) await admin(`/api/customers/${f.customers[580 + i]!.id}`, { isActive: false }, "PATCH");
  }
  const variant = f.byName.get("Pav bhaji")!.variants[1]!;
  await admin(`/api/variants/${variant.id}`, { isActive: false }, "PATCH");
  await admin(`/api/tables/${tables[23]!.id}`, { isActive: false }, "PATCH");
  await adjustStock(db, f, "Coriander", "adjustment", 1.2, "End of morning count");
  await adjustStock(db, f, "Curry leaves", "adjustment", 0, "Reorder on next supplier run");
  await admin(`/api/customers/${f.customers[0]!.id}/loyalty-adjustments`, { clientRef: ref(), points: 80, note: "Sample welcome points" });
  await admin(`/api/customers/${f.customers[0]!.id}/loyalty-adjustments`, { clientRef: ref(), points: -10, note: "Sample points correction" });
}

/** Called only while building an unpublished sample database. The normal listener uses real time. */
export async function createSampleRestaurant(target: string, photos: string, options: { onProgress?: () => void } = {}) {
  const anchor = Date.now();
  const progress = options.onProgress ?? (() => {});
  progress();
  const db = openDb(target);
  const fake = makeFakeSink();
  let app: ReturnType<typeof buildServer> | undefined;
  mock.timers.enable({ apis: ["Date"], now: dayAt(anchor, -PAST_DAYS - 1, 8) });
  const setTime = (time: number) => mock.timers.setTime(time);
  try {
    migrate(db, MIGRATIONS);
    // This database has no listener or other writers. API transactions use savepoints inside the seed transaction.
    db.exec("BEGIN");
    app = buildServer({ db, sampleData: true, port: 4120, sinkSend: fake.send });
    const fixtures = await buildSampleFixtures(app, photos, anchor, setTime);
    const market = await seedHistory(db, fixtures, anchor, setTime, progress);
    progress();
    await buildReports(fixtures, market, anchor);
    await seedLive(db, fixtures, fake, anchor, setTime);
    await app.close();
    app = undefined;
    db.prepare("DELETE FROM sessions").run();
    db.exec("COMMIT");
    const total = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    if (total("SELECT COUNT(*) AS n FROM products WHERE kind='item' AND addon_only=0") !== 320
        || total("SELECT COUNT(*) AS n FROM customers") !== 600
        || total("SELECT COUNT(*) AS n FROM bill_settlements") !== 3000
        || db.pragma("integrity_check", { simple: true }) !== "ok"
        || (db.pragma("foreign_key_check") as unknown[]).length) {
      throw new Error("The sample restaurant failed database and record-count checks.");
    }
  } finally {
    try { await app?.close(); }
    finally { mock.timers.reset(); db.close(); }
  }
}
