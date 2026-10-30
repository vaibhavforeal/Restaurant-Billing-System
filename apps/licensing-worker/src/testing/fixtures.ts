// Test-only: portal rows written straight into the store, so licensing tests need not drive the portal API.
import { makeVendorCode } from "@forkflow/domain/vendor-codes";
import type { ModuleOverrides } from "@forkflow/domain/modules";
import type { D1Like } from "../env.js";

let sequence = 0;
/** Distinct, valid codes without randomness, so a failing test reproduces. */
const nextBytes = () => { sequence++; return Uint8Array.of(sequence & 31, (sequence >> 5) & 31, (sequence >> 10) & 31, 7, 11, 13); };

export interface Seeded { id: string; code: string }

export async function seedCustomer(db: D1Like, over: { name?: string; ownerId?: string | null; stateCode?: string | null; at?: number } = {}): Promise<Seeded> {
  const id = crypto.randomUUID(), code = makeVendorCode("customer", nextBytes()), at = over.at ?? Date.now();
  await db.prepare(`INSERT INTO customers (id, code, business_name, owner_id, state_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, code, over.name ?? "Spice Route", over.ownerId ?? null, over.stateCode ?? null, at, at).run();
  return { id, code };
}

export interface OrderSeed {
  kind?: "new" | "renewal" | "trial"; plan?: "basic" | "pro"; termMonths?: number; termDays?: number; outlets?: number; maxDevices?: number;
  modules?: ModuleOverrides; status?: "draft" | "confirmed" | "paid" | "cancelled"; creditUntil?: number | null; ownerId?: string | null;
  totalPaise?: number; at?: number;
}

/** A paid one-outlet Pro order for 12 months by default; a trial runs 7 days and is confirmed. */
export async function seedOrder(db: D1Like, customer: Seeded, over: OrderSeed = {}): Promise<Seeded> {
  const id = crypto.randomUUID(), code = makeVendorCode("order", nextBytes()), at = over.at ?? Date.now();
  const kind = over.kind ?? "new", trial = kind === "trial";
  await db.prepare(`INSERT INTO orders (id, code, customer_id, owner_id, kind, plan, term_months, term_days, outlets, max_devices, modules, status,
      credit_until, total_paise, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, code, customer.id, over.ownerId ?? null, kind, over.plan ?? "pro", trial ? null : over.termMonths ?? 12, trial ? over.termDays ?? 7 : null,
      over.outlets ?? (kind === "renewal" ? 0 : 1), over.maxDevices ?? 5, JSON.stringify(over.modules ?? {}), over.status ?? (trial ? "confirmed" : "paid"),
      over.creditUntil ?? null, over.totalPaise ?? 0, at, at).run();
  return { id, code };
}
