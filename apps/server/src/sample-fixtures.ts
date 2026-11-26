
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { gstinCheckChar, localDateKey } from "@masalapos/domain";
import { SAMPLE_UPI_ID } from "./print/upi.js";
import { SAMPLE_MENU, SAMPLE_GIVEN_NAMES, SAMPLE_FAMILY_NAMES } from "./sample-menu.js";

export type Request = <T = unknown>(
  url: string, payload?: object, method?: "POST" | "GET" | "PATCH" | "PUT", headers?: Record<string, string>,
) => Promise<T>;
export const ref = randomUUID;
export const SAMPLE_PASSWORD = "demo1234";
export const SAMPLE_PIN = "1234";
export type Id = { id: string };
type Product = Id & { name: string; variants: Id[]; combo?: Array<{ options: Id[] }> };
type Customer = Id & { name: string; phone: string; gstin: string | null; legalName: string | null };

export function client(app: FastifyInstance, token = ""): Request {
  return async <T>(url: string, payload?: object, method: "POST" | "GET" | "PATCH" | "PUT" = "POST", headers = {}) => {
    const response = await app.inject({ url, method, ...(payload === undefined ? {} : { payload }),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
    if (response.statusCode >= 400) throw new Error(`Sample data ${method} ${url}: ${response.statusCode} ${response.body}`);
    return (response.body ? response.json() : undefined) as T;
  };
}

function gstin(pan: string) {
  const prefix = `29${pan}1Z`;
  return prefix + gstinCheckChar(prefix);
}

export function dayAt(anchor: number, offset: number, hour = 0) {
  const day = new Date(anchor);
  day.setDate(day.getDate() + offset);
  day.setHours(hour, 0, 0, 0);
  return day.getTime();
}

export async function buildSampleFixtures(app: FastifyInstance, photos: string, anchor: number, setTime: (time: number) => void) {
  const call = client(app);
  const profile = {
    restaurantName: "The Indian Table · Sample Restaurant", address: "12 Sample Market Road, Indiranagar",
    city: "Bengaluru", stateCode: "29", pincode: "560038", phone: "8000000000",
    gstin: gstin("ZZZZZ0000Z"), fssai: "10000000000000",
  };
  const positions = [
    { username: "cashier", name: "Meera Rao", role: "cashier" },
    { username: "cashier2", name: "Rohan Sen", role: "cashier" },
    { username: "captain", name: "Ananya Joshi", role: "waiter" },
    { username: "captain2", name: "Ishaan Naik", role: "waiter" },
    { username: "kitchen", name: "Farah Khan", role: "kitchen" },
    { username: "kitchen2", name: "Arjun Das", role: "kitchen" },
  ] as const;
  const setup = await call<{ token: string; user: Id }>("/api/setup", {
    ...profile, username: "admin", adminName: "Aditi Menon", password: SAMPLE_PASSWORD, pin: SAMPLE_PIN,
  });
  const admin = client(app, setup.token);
  const staff = new Map<string, { user: Id; request: Request }>();
  for (const position of positions) {
    const { user } = await admin<{ user: Id }>("/api/users", { ...position, password: SAMPLE_PASSWORD });
    const { token } = await call<{ token: string }>("/api/login", { username: position.username, password: SAMPLE_PASSWORD });
    staff.set(position.username, { user, request: client(app, token) });
  }
  await admin("/api/settings", {
    ...profile, gstMode: "included", gstRate: 5, zomatoGstin: gstin("ZZZZZ0001Z"), sacCode: "996331",
    invoicePrefix: "DEV", receiptHeader: "Regional Indian kitchen", receiptFooter: "SAMPLE DATA · Not a tax document",
    receiptStyle: "heritage", roundOff: "rupee", serviceChargeBp: 500, packagingChargePaise: 500,
    serviceChargeLabel: "Service charge", packagingChargeLabel: "Takeaway packaging", packagingPerItem: true,
    billShowFssai: true, billShowCustomer: true, billShowTable: true, billShowServedBy: true, billShowItemGst: true,
    holdOrdersEnabled: true, popularItemsEnabled: true, popularByTimeEnabled: true,
    orderedTogetherEnabled: true, customerUsualEnabled: true, kotEditPrint: "ask", upiId: SAMPLE_UPI_ID,
  }, "PUT");
  for (const id of ["takeaway", "reservations", "qrOrdering", "guestServices", "inventory", "recipes", "costing", "kds", "crm", "offers", "dynamicReports", "zomato"]) {
    await admin(`/api/modules/${id}`, { enabled: true }, "PATCH");
  }
  await admin("/api/discount-caps", { caps: [{ role: "cashier", maxPercent: 5 }, { role: "waiter", maxPercent: 0 }, { role: "kitchen", maxPercent: 0 }] }, "PUT");
  await admin("/api/settings/activity-alerts", { cashShortPaise: 5000, discountPercent: 10, payOutPaise: 10000, multiplier: 2, minEvents: 2 }, "PUT");
  const inactive = await admin<{ user: Id }>("/api/users", { name: "Nikhil Bhat", username: "inactive", role: "waiter", password: SAMPLE_PASSWORD });
  await admin(`/api/users/${inactive.user.id}`, { isActive: false }, "PATCH");
  await admin(`/api/users/${staff.get("cashier2")!.user.id}/permissions`, { overrides: { "reports.dashboard": true } }, "PUT");
  await admin(`/api/users/${staff.get("cashier")!.user.id}`, { maxDiscountPercent: 8 }, "PATCH");
  const stations = new Map<string, Id>();
  for (const name of new Set(SAMPLE_MENU.map(group => group.station))) {
    const { station } = await admin<{ station: Id }>("/api/kot-stations", { name });
    stations.set(name, station);
  }
  const prices = (base: number) => ({ pricePaise: base, acPricePaise: base + 1500, takeawayPricePaise: base - 500,
    zomatoPricePaise: base + 3500, packagingPaise: 500 });

  const ingredientSpecs = [
    ["Basmati rice", "kg", 120, 36000], ["Parboiled rice", "kg", 120, 18000], ["Urad dal", "kg", 75, 24000],
    ["Toor dal", "kg", 80, 22000], ["Chickpeas", "kg", 95, 18000], ["Besan", "kg", 95, 18000], ["Wheat flour", "kg", 110, 12000],
    ["Mixed vegetables", "kg", 120, 14000], ["Tomatoes", "kg", 120, 7000], ["Onions", "kg", 130, 6500],
    ["Paneer", "kg", 70, 46000], ["Chicken", "kg", 90, 28000], ["Mutton", "kg", 60, 76000],
    ["Fish", "kg", 55, 65000], ["Pork", "kg", 50, 51000], ["Prawns", "kg", 35, 95000], ["Eggs", "pcs", 500, 850],
    ["Milk", "L", 120, 7200], ["Curd", "kg", 85, 8400], ["Coconut milk", "L", 42, 23000],
    ["Cooking oil", "L", 40, 18000], ["Ghee", "L", 25, 69000], ["Spice blend", "kg", 20, 40000],
    ["Sugar", "kg", 55, 5200], ["Ginger", "g", 4400, 20], ["Lemon juice", "ml", 9000, 16],
    ["Mango pulp", "kg", 45, 19000], ["Tea leaves", "kg", 8, 62000], ["Coffee powder", "kg", 8, 68000],
    ["Coriander", "kg", 2, 14000], ["Curry leaves", "kg", 4, 22000], ["Saffron", "g", 2, null],
  ] as const;
  const stocks = new Map<string, Id & { version: number }>();
  for (const [name, unit, openingQty, cost] of ingredientSpecs) {
    const { item } = await admin<{ item: Id & { version: number } }>("/api/stock-items", {
      clientRef: ref(), name, unit, openingQty, lowStockThreshold: name === "Coriander" ? 3 : unit === "pcs" ? 30 : 2,
    });
    stocks.set(name, item);
    if (cost) await admin(`/api/stock-items/${item.id}/unit-cost`, {
      clientRef: ref(), expectedVersion: item.version, unitCostMilliPaise: cost * 1000, note: "Opening purchase cost",
    });
  }

  const meat = (name: string) => {
    if (/prawn|chingri|crab/i.test(name)) return "Prawns";
    if (/fish|maach|mach|ilish|masor|moilee|meen|kingfish|mackerel|nga|bombil|berma/i.test(name)) return "Fish";
    if (/pork|sorpotel|pandi|wahan|sausage|vindaloo/.test(name.toLowerCase())) return "Pork";
    if (/egg|anda/.test(name.toLowerCase())) return "Eggs";
    if (/mutton|gosht|mangsho|maas|keema|nihari|galouti|shami|chapli/i.test(name)) return "Mutton";
    return "Chicken";
  };
  const dishIngredients = (name: string, group: typeof SAMPLE_MENU[number], veg: boolean): [string, number][] => {
    if (group.name === "Drinks") {
      if (name.includes("lassi") || name.includes("chaas")) return [["Curd", .18], [name === "Mango lassi" ? "Mango pulp" : "Sugar", .025]];
      if (name.includes("coffee") || name.includes("chai") || name.includes("kahwa")) return [[name.includes("coffee") ? "Coffee powder" : "Tea leaves", .012], ["Milk", .15]];
      return [["Lemon juice", 15], ["Sugar", .02]];
    }
    if (group.name === "Desserts") return [["Milk", .14], ["Sugar", .035], [name === "Rasmalai" ? "Saffron" : "Ghee", .012]];
    const main = !veg ? meat(name) : name.toLowerCase().includes("paneer") ? "Paneer" : name.toLowerCase().includes("chole") ? "Chickpeas" : /dal /i.test(name) ? "Toor dal" : "Mixed vegetables";
    if (group.name === "Rice, Pulao & Biryani") return [["Basmati rice", .115], [main, main === "Eggs" ? 1 : .09], ["Spice blend", .008]];
    if (group.name === "South Indian Breakfast") return [["Parboiled rice", .075], ["Urad dal", .032], ["Cooking oil", .012]];
    if (group.name === "Breads") return [["Wheat flour", .07], ["Ghee", .008]];
    return [[main, main === "Eggs" ? 2 : .15], [group.station === "Tawa & Breakfast" ? "Besan" : "Onions", .04], ["Spice blend", .006]];
  };

  const products: Product[] = [];
  const unavailable: Product[] = [];
  const byName = new Map<string, Product>();
  const photographed = {
    "Masala dosa": "Crisp rice dosa with spiced potato, coconut chutney and sambar.",
    "Chole bhature": "Punjabi chickpea masala with puffed bhature and sliced onions.",
    "Paneer butter masala": "Paneer in a buttery tomato and cashew gravy.",
    "Hyderabadi chicken biryani": "Dum-cooked basmati rice layered with spiced chicken and fried onions.",
    "Khaman dhokla": "Steamed gram flour cakes with mustard seeds, curry leaves and coriander.",
    "Pav bhaji": "Mumbai-style buttered pav with a slow-cooked vegetable mash.",
    "Goan fish curry": "Fish simmered in a tangy coconut and spice gravy.",
    "Rasmalai": "Soft chhena patties in saffron milk with pistachios.",
    "Mango lassi": "Chilled curd blended with ripe mango pulp.",
  } as Record<string, string>;
  for (const [categoryIndex, group] of SAMPLE_MENU.entries()) {
    const { category } = await admin<{ category: Id }>("/api/categories", { name: group.name, sortOrder: categoryIndex });
    for (const [index, dish] of group.dishes.split("|").entries()) {
      const isVeg = !dish.endsWith("*");
      const name = dish.replace(/\*$/, "");
      const base = (group.price + 5 * ((index * 7 + categoryIndex) % 11) + (isVeg ? 0 : 35)) * 100;
      const file = join(photos, name.toLowerCase().replaceAll(" ", "-") + ".jpg");
      const { product } = await admin<{ product: Product }>("/api/products", {
        categoryId: category.id, name, ...prices(base), gstRate: index % 17 === 16 ? 0 : index % 6 === 0 ? 5 : null,
        isVeg, kotStationId: stations.get(group.station)!.id,
        description: photographed[name] ?? `${group.name} · ${isVeg ? "Vegetarian" : "Non-vegetarian"}`,
        ...(photographed[name] ? { photo: "data:image/jpeg;base64," + readFileSync(file).toString("base64") } : {}),
        variants: index % 5 === 0 ? [{ name: "Regular", ...prices(base) }, { name: "Large", ...prices(base + 7500), packagingPaise: 750 }] : [],
      });
      products.push(product); byName.set(name, product);
      if (index === 19) unavailable.push(product);
      if (index !== 18) await admin(`/api/products/${product.id}/recipe`, {
        expectedVersion: 0, ingredients: dishIngredients(name, group, isVeg).map(([stock, qtyPerSale]) => ({ stockItemId: stocks.get(stock)!.id, qtyPerSale })),
      }, "PUT");
    }
  }
  const { category: archivedCategory } = await admin<{ category: Id }>("/api/categories", { name: "Previous seasonal menu", sortOrder: 21 });
  await admin(`/api/categories/${archivedCategory.id}`, { isActive: false }, "PATCH");
  const { category: specials } = await admin<{ category: Id }>("/api/categories", { name: "Meals & Extras", sortOrder: 20 });
  const extras = [];
  for (const [name, pricePaise] of [["Extra sambar", 3500], ["Coconut chutney", 0], ["Fried papad", 2500]] as const) {
    const { product } = await admin<{ product: Product }>("/api/products", {
      name, pricePaise, categoryId: specials.id, addonOnly: true, kotStationId: stations.get("Tawa & Breakfast")!.id,
    });
    extras.push(product);
  }
  const { group } = await admin<{ group: Id & { options: Id[] } }>("/api/addon-groups", {
    name: "Dosa accompaniments", minPicks: 0, maxPicks: 2, options: extras.map(product => ({ productId: product.id })),
  });
  const dosa = byName.get("Masala dosa")!;
  await admin(`/api/products/${dosa.id}`, { addonGroupIds: [group.id] }, "PATCH");
  const option = (name: string, extraPricePaise = 0) => {
    const product = byName.get(name)!;
    return { productId: product.id, variantId: product.variants[0]?.id ?? null, extraPricePaise, qty: 1 };
  };
  const { product: combo } = await admin<{ product: Product }>("/api/products", {
    name: "Bengaluru Lunch Thali", kind: "combo", categoryId: specials.id, ...prices(32500),
    description: "Choose a curry with jeera rice and a drink.",
    combo: [
      { name: "Main", minPicks: 1, maxPicks: 1, options: [option("Dal tadka"), option("Paneer butter masala", 3500)] },
      { name: "Rice", minPicks: 1, maxPicks: 1, options: [option("Jeera rice")] },
      { name: "Drink", minPicks: 1, maxPicks: 1, options: [option("Salted lassi"), option("Mango lassi", 2500)] },
    ],
  });
  const comboPicks = [combo.combo![0]!.options[1]!.id, combo.combo![2]!.options[1]!.id];

  const offer = { state: "active", minimumPaise: 0, kinds: ["dine_in"], weekdays: [0, 1, 2, 3, 4, 5, 6],
    firstDate: null, lastDate: null, startTime: null, endTime: null };
  const lassi = byName.get("Mango lassi")!;
  const target = { productId: lassi.id, variantId: lassi.variants[0]!.id };
  await admin("/api/offers", { ...offer, name: "Lunch for less", minimumPaise: 60000, startTime: "11:30", endTime: "15:00", benefit: { kind: "percent", percent: 8 } });
  await admin("/api/offers", { ...offer, name: "Two mango lassis", kinds: ["takeaway", "delivery"], benefit: { kind: "bogo", buy: 1, get: 1, qualifying: [target], rewards: [target] } });
  await admin("/api/offers", { ...offer, name: "Weekend dinner ₹40 off", minimumPaise: 75000, weekdays: [0, 6], startTime: "18:00", endTime: "23:00", benefit: { kind: "fixed", paise: 4000 } });
  await admin("/api/offers", { ...offer, name: "Monsoon offer", state: "paused", benefit: { kind: "fixed", paise: 3000 } });
  await admin("/api/offers", { ...offer, name: "Opening week", state: "archived", lastDate: localDateKey(dayAt(anchor, -365)), benefit: { kind: "percent", percent: 5 } });

  const types: Id[] = [];
  for (const [name, percent] of [["Regular", 5], ["Neighbour", 3], ["Business", 6], ["Staff", 10]] as const) {
    const { customerType } = await admin<{ customerType: Id }>("/api/customer-types", { name, slabs: [
      { minBillPaise: 45000, percent }, { minBillPaise: 100000, percent: percent + 2, validFrom: localDateKey(dayAt(anchor, -45)), validTo: localDateKey(dayAt(anchor, 45)) },
    ] });
    types.push(customerType);
  }
  await admin("/api/loyalty-settings", { enabled: true, pointsPer100: 4, pointValuePaise: 50, minRedeemPoints: 20,
    expiryMonths: 9, tiersEnabled: true, tierWindowMonths: 12, maxRedeemPercent: 20, feedbackEnabled: true }, "PUT");
  for (const [name, minSpendPaise, earnMultiplier] of [["Silver", 100000, 1], ["Gold", 300000, 1.25], ["Platinum", 800000, 1.5]] as const) {
    await admin("/api/loyalty-tiers", { name, minSpendPaise, earnMultiplier });
  }
  for (const [name, filter] of [
    ["Regulars", { minVisits: 3 }], ["Lapsed guests", { notVisitedForDays: 60 }], ["Upcoming birthdays", { occasion: { kind: "birthday", withinDays: 30 } }],
    ["Opted in for news", { optedInOnly: true, tags: ["Weekend"] }],
  ] as const) await admin("/api/customer-segments", { name, filter });

  const customers: Customer[] = [];
  async function addCustomer(index: number) {
    const name = `${SAMPLE_GIVEN_NAMES[index % SAMPLE_GIVEN_NAMES.length]} ${SAMPLE_FAMILY_NAMES[Math.floor(index / SAMPLE_GIVEN_NAMES.length)]}`;
    const business = index % 23 === 0;
    const { customer } = await admin<{ customer: Customer }>("/api/customers", {
      name, phone: `800000${String(index + 1).padStart(4, "0")}`, email: `guest-${index + 1}@example.invalid`,
      typeId: business ? types[2]!.id : index % 3 === 0 ? types[index % 2]!.id : null,
      notes: ["Sample customer", "Prefers a quiet table", "Usually orders takeaway", "Enjoys regional specials"][index % 4],
      birthDate: `--${String(index % 12 + 1).padStart(2, "0")}-${String((index * 3) % 28 + 1).padStart(2, "0")}`,
      anniversaryDate: index % 4 === 0 ? `--${String(index % 12 + 1).padStart(2, "0")}-17` : null,
      gender: (["female", "male", "other", null] as const)[index % 4], marketingOptIn: index % 3 === 0,
      tags: [index % 2 ? "Weekend" : "Lunch", ...(business ? ["Business"] : [])],
      ...(business ? { gstin: gstin(`ZZZZZ${String(index + 100).padStart(4, "0")}Z`), legalName: `${name.split(" ")[1]} Sample Office ${index + 1}` } : {}),
    });
    customers.push(customer);
  }
  for (let index = 0; index < 540; index++) await addCustomer(index);
  const addRecentCustomers = async () => {
    for (let index = 540; index < 600; index++) await addCustomer(index);
  };

  const tables: Id[] = [];
  for (const [index, [area, prefix]] of [
    ["Main hall", "M"], ["AC dining", "AC"], ["Terrace", "T"],
  ].entries()) {
    for (let i = 1; i <= 8; i++) {
      const { table } = await admin<{ table: Id }>("/api/tables", { name: `${prefix}${String(i).padStart(2, "0")}`,
        area, priceTier: index === 1 ? "ac" : "non_ac", sortOrder: index * 10 + i });
      tables.push(table);
    }
  }
  const { orderType: pickup } = await admin<{ orderType: Id }>("/api/order-types", { name: "Phone pickup", kind: "takeaway" });
  const { orderType: delivery } = await admin<{ orderType: Id }>("/api/order-types", { name: "House delivery", kind: "delivery" });
  const { orderType: inactiveType } = await admin<{ orderType: Id }>("/api/order-types", { name: "Seasonal counter", kind: "takeaway" });
  await admin(`/api/order-types/${inactiveType.id}`, { isActive: false }, "PATCH");

  await admin("/api/drawers", { name: "Takeaway drawer" });
  const { drawers } = await admin<{ drawers: Array<Id & { name: string }> }>("/api/drawers", undefined, "GET");
  setTime(dayAt(anchor, -395, 9));
  return {
    admin, adminId: setup.user.id, staff, products, unavailable, byName, stocks, extras, stations, combo, comboPicks,
    addonPicks: [group.options[0]!.id, group.options[1]!.id], customers, addRecentCustomers, tables,
    pickup, delivery, sideDrawer: drawers.find(drawer => drawer.name === "Takeaway drawer")!.id,
  };
}
export type SampleFixtures = Awaited<ReturnType<typeof buildSampleFixtures>>;
