import { uuidv7 } from "@masalapos/domain/id";
import type { SqlDriver } from "./driver.js";
import { dataChanged } from "./events.js";

export interface Customer { id: string; name: string; phone: string; addressNote: string }
export type CustomerErrorCode = "invalid" | "phone_taken" | "not_found";
export class CustomerError extends Error {
  constructor(readonly code: CustomerErrorCode, message: string, readonly existingId?: string) {
    super(message);
    this.name = "CustomerError";
  }
}

/**
 * An Indian mobile number as its 10 digits: spaces, dashes and brackets go, then a leading +91, a 91 on a 12-digit
 * number, or a 0 on an 11-digit one. Anything that is not then 10 digits starting 6-9 is null.
 */
export function normalisePhone(raw: string): string | null {
  let d = raw.replace(/[\s\-()]/g, "");
  if (d.startsWith("+91")) d = d.slice(3);
  else if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/** As the Windows POS masks it on a receipt: only the last four digits show. */
export const maskPhone = (phone: string): string => `******${phone.slice(-4)}`;

interface Row { id: string; name: string; phone: string; address_note: string }
const toCustomer = (r: Row): Customer => ({ id: r.id, name: r.name, phone: r.phone, addressNote: r.address_note });

/** Live customers only. */
export function getCustomer(db: SqlDriver, id: string): Customer | null {
  const r = db.get<Row>("SELECT id, name, phone, address_note FROM customers WHERE id = ? AND deleted_at IS NULL", [id]);
  return r ? toCustomer(r) : null;
}

/** Adds (no id) or edits a customer. A phone held by another live customer is `phone_taken`, naming that customer. */
export function saveCustomer(db: SqlDriver, input: { id?: string; name: string; phone: string; addressNote?: string }, now: number): Customer {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) throw new CustomerError("invalid", "Enter a name of up to 60 characters");
  const phone = normalisePhone(input.phone);
  if (!phone) throw new CustomerError("invalid", "Enter a 10-digit mobile number");
  const addressNote = (input.addressNote ?? "").trim();
  if (addressNote.length > 200) throw new CustomerError("invalid", "Keep the address to 200 characters");
  const id = input.id ?? uuidv7();
  db.transaction(() => {
    if (input.id && !getCustomer(db, input.id)) throw new CustomerError("not_found", "This customer was deleted");
    const holder = db.get<{ id: string; name: string }>(
      "SELECT id, name FROM customers WHERE phone = ? AND deleted_at IS NULL AND id <> ?", [phone, id]);
    if (holder) throw new CustomerError("phone_taken", `This number belongs to ${holder.name}`, holder.id);
    if (input.id) {
      db.run("UPDATE customers SET name = ?, phone = ?, address_note = ?, updated_at = ? WHERE id = ?", [name, phone, addressNote, now, id]);
    } else {
      db.run("INSERT INTO customers (id, name, phone, address_note, updated_at) VALUES (?, ?, ?, ?, ?)", [id, name, phone, addressNote, now]);
    }
  });
  dataChanged();
  return { id, name, phone, addressNote };
}

/** Live customers whose name contains the query (any case), or whose phone contains its digits when it has 3 or more. By name. */
export function findCustomers(db: SqlDriver, query: string, limit = 20): Customer[] {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = db.all<Row>(
    `SELECT id, name, phone, address_note FROM customers WHERE deleted_at IS NULL
      AND (lower(name) LIKE ? ESCAPE '\\' OR (? AND phone LIKE ?)) ORDER BY name COLLATE NOCASE LIMIT ?`,
    [like(q), digits.length >= 3 ? 1 : 0, like(digits), limit]);
  return rows.map(toCustomer);
}

/** Soft delete. Old bills keep the name frozen in their receipt. */
export function deleteCustomer(db: SqlDriver, id: string, now: number): void {
  db.transaction(() => db.run("UPDATE customers SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [now, now, id]));
  dataChanged();
}
