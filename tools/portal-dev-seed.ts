// Local development only: a sandbox ForkFlow Portal with one staff account per role and sample data, so screens can be designed and tested
// against real-looking content. Never point it at the live portal; the passwords are public.
//   1. Run the Node server on a throwaway database (see docs/portal-redesign-brief.md), e.g. on port 8799.
//   2. node --import tsx tools/portal-dev-seed.ts <db-file> [--api http://127.0.0.1:8799]
// Without --api only the staff accounts are written. With it, customers, leads, orders, payments, tickets and follow-ups are added through
// the portal's own API, as the staff who would own them.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fileD1 } from "../apps/licensing-node/src/sqlite-d1.js";
import { hashPassword } from "../apps/licensing-worker/src/portal/passwords.js";

const PASSWORD = "portal-demo-pass";
const STAFF = [
  { email: "vaibhav@forkflow.test", name: "Vaibhav", role: "admin" }, { email: "ritu@forkflow.test", name: "Ritu", role: "sales" },
  { email: "kabir@forkflow.test", name: "Kabir", role: "sales" }, { email: "imran@forkflow.test", name: "Imran", role: "accounts" },
  { email: "neha@forkflow.test", name: "Neha", role: "support" },
] as const;

const { positionals, values } = parseArgs({ allowPositionals: true, options: { api: { type: "string" } } });
const [dbFile] = positionals;
if (!dbFile) throw new Error("Usage: portal-dev-seed.ts <db-file> [--api http://127.0.0.1:8799]");

const { d1, db } = fileD1(dbFile, fileURLToPath(new URL("../apps/licensing-worker/migrations", import.meta.url)));
const now = Date.now();
for (const s of STAFF) {
  await d1.prepare(`INSERT OR IGNORE INTO staff_users (id, email, name, role, password_hash, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
    .bind(randomUUID(), s.email, s.name, s.role, await hashPassword(PASSWORD), now, now).run();
}
db.close();
console.log(`Staff ready (password ${PASSWORD}): ${STAFF.map((s) => `${s.email} [${s.role}]`).join(", ")}`);
if (!values.api) process.exit(0);

const base = values.api.replace(/\/+$/, ""), origin = new URL(base).origin;
async function signIn(email: string) {
  const res = await fetch(`${base}/portal/api/login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (!res.ok) throw new Error(`sign-in as ${email} failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return async <T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${base}/portal/api${path}`, { method, headers: { "content-type": "application/json", origin, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return await r.json() as T;
  };
}
const [admin, ritu, kabir, accounts, support] = await Promise.all(STAFF.map((s) => signIn(s.email)));
const DAY = 86_400_000;

await admin!("PUT", "/settings", {
  seller: { legalName: "ForkFlow Technologies LLP", gstin: "27AAPFU0939F1ZV", address: "Baner Road", city: "Pune", stateCode: "27", pincode: "411045", email: "accounts@forkflow.in", phone: "98200 00000" },
  invoice: { prefix: "FF", sac: "997331", gstRateBp: 1800, bankDetails: "HDFC Bank, A/c 5020001234, IFSC HDFC0000123", terms: "Payment due within 15 days." },
  prices: [], extraDevicePaise: 0, trialDays: 7,
});

const names: Array<[string, string, string, string]> = [ // business, contact, city, owner-key
  ["Spice Route", "Meera", "Pune", "ritu"], ["Chai Point Baner", "Rohit", "Pune", "ritu"], ["Coastal Kitchen", "Anita", "Goa", "kabir"],
  ["Dosa Plaza", "Suresh", "Nagpur", "kabir"], ["The Biryani House", "Farhan", "Hyderabad", "ritu"],
];
const customers: Array<{ id: string; code: string }> = [];
for (const [businessName, contactName, city, owner] of names) {
  const as = owner === "ritu" ? ritu! : kabir!;
  const { customer } = await as("POST", "/customers", { businessName, contactName, phone: "98220 1234" + customers.length, email: `${contactName.toLowerCase()}@example.test`, gstin: "", address: "Main Road", city,
    stateCode: "27", pincode: "411004", notes: "" });
  customers.push(customer);
}

const order = async (as: typeof ritu, customerId: string, over: Record<string, unknown> = {}) => (await as!("POST", "/orders", { customerId, kind: "new", plan: "pro", termMonths: 12, outlets: 1, maxDevices: 5,
  modules: {}, pricePerOutletPaise: 1_000_000, discountPaise: 0, extras: [], installationIds: [], notes: "", ...over })).order;
const paid = await order(ritu, customers[0]!.id); await ritu!("POST", `/orders/${paid.id}/confirm`);
await accounts!("POST", `/orders/${paid.id}/payments`, { amountPaise: paid.totalPaise, method: "upi", reference: "UPI-4411", receivedAt: now, note: "", pending: false });
const part = await order(ritu, customers[1]!.id, { outlets: 2 }); await ritu!("POST", `/orders/${part.id}/confirm`);
await accounts!("POST", `/orders/${part.id}/payments`, { amountPaise: 500_000, method: "bank", reference: "NEFT-9021", receivedAt: now, note: "Advance", pending: false });
const waiting = await order(kabir, customers[2]!.id, { plan: "basic", pricePerOutletPaise: 700_000 }); await kabir!("POST", `/orders/${waiting.id}/confirm`);
await order(kabir, customers[3]!.id, { termMonths: 24, pricePerOutletPaise: 1_800_000, discountPaise: 100_000 }); // stays a draft

const stages = ["new", "contacted", "demo_scheduled", "demo_done", "proposal"] as const;
for (const [i, businessName] of ["Tandoor Tales", "Brew & Bites", "Idli Express", "Pizza Corner", "Lotus Cafe"].entries()) {
  const as = i % 2 ? kabir! : ritu!;
  const { lead } = await as("POST", "/leads", { businessName, contactName: "Owner", phone: `98500 1122${i}`, email: "", city: "Mumbai", stateCode: "27", source: "walk_in", expectedPlan: "pro",
    expectedOutlets: 1 + (i % 3), estimatedValuePaise: 1_500_000 * (1 + (i % 3)), notes: "" });
  if (stages[i]! !== "new") await as("POST", `/leads/${lead.id}/stage`, { stage: stages[i] });
  await as("POST", "/follow-ups", { leadId: lead.id, kind: "call", dueAt: now + (i - 1) * DAY, note: `Call ${businessName} about the demo` });
}
await ritu!("POST", "/follow-ups", { customerId: customers[1]!.id, kind: "payment", dueAt: now - DAY, note: "Chase the balance payment" });

for (const [subject, category, priority] of [["KOT printer prints blank", "printing", "high"], ["Needs GST report training", "training", "normal"], ["Cannot activate the second counter", "activation", "urgent"]] as const) {
  await support!("POST", "/tickets", { customerId: customers[0]!.id, installationId: null, subject, description: "Reported by phone.", category, priority, assigneeId: null });
}
console.log(`Sample data added through ${base}: ${customers.length} customers, 4 orders (1 paid, 1 part-paid, 1 waiting, 1 draft), 5 leads, follow-ups and 3 tickets.`);
