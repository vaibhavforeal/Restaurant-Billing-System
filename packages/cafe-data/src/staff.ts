import { uuidv7 } from "@masalapos/domain/id";
import type { SqlDriver } from "./driver.js";
import { dataChanged } from "./events.js";
import { CAFE_ROLES, type CafeRole } from "./roles.js";

export interface Staff { id: string; name: string; role: CafeRole; active: boolean; sort: number }
export type StaffErrorCode = "invalid" | "not_found" | "last_owner";
export class StaffError extends Error {
  constructor(readonly code: StaffErrorCode, message: string) { super(message); this.name = "StaffError"; }
}

interface StaffRow { id: string; name: string; role: CafeRole; active: number; sort: number }
const toStaff = (r: StaffRow): Staff => ({ id: r.id, name: r.name, role: r.role, active: r.active === 1, sort: r.sort });
const COLUMNS = "id, name, role, active, sort";

function cleanName(raw: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > 30) throw new StaffError("invalid", "Enter a name of up to 30 characters");
  return name;
}
function checkRole(role: string): CafeRole {
  if (!CAFE_ROLES.includes(role as CafeRole)) throw new StaffError("invalid", "Choose a role");
  return role as CafeRole;
}

/** Live staff by sort, then name. Inactive people only when asked for. */
export function listStaff(db: SqlDriver, opts: { includeInactive?: boolean } = {}): Staff[] {
  const active = opts.includeInactive ? "" : "AND active = 1";
  return db.all<StaffRow>(`SELECT ${COLUMNS} FROM staff WHERE deleted_at IS NULL ${active} ORDER BY sort, name`).map(toStaff);
}

/** One person, active or not. */
export function getStaff(db: SqlDriver, id: string): Staff | null {
  const r = db.get<StaffRow>(`SELECT ${COLUMNS} FROM staff WHERE id = ? AND deleted_at IS NULL`, [id]);
  return r ? toStaff(r) : null;
}

export function staffPinHash(db: SqlDriver, id: string): string | null {
  return db.get<{ pin_hash: string }>("SELECT pin_hash FROM staff WHERE id = ? AND deleted_at IS NULL", [id])?.pin_hash ?? null;
}

export function addStaff(db: SqlDriver, input: { name: string; role: CafeRole; pinHash: string }, now: number): Staff {
  const name = cleanName(input.name);
  const role = checkRole(input.role);
  if (!input.pinHash) throw new StaffError("invalid", "Set a PIN");
  const id = uuidv7();
  db.transaction(() => {
    const sort = (db.get<{ m: number | null }>("SELECT MAX(sort) AS m FROM staff")?.m ?? 0) + 1;
    db.run("INSERT INTO staff (id, name, role, pin_hash, active, sort, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
      [id, name, role, input.pinHash, sort, now]);
  });
  dataChanged();
  return getStaff(db, id)!;
}

function activeOwnerCount(db: SqlDriver): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner' AND active = 1 AND deleted_at IS NULL")!.n;
}

/** Changes name, role or active. Refuses with `last_owner` when the change would leave the cafe with no active owner. */
export function updateStaff(db: SqlDriver, id: string, change: { name?: string; role?: CafeRole; active?: boolean }, now: number): Staff {
  db.transaction(() => {
    const current = getStaff(db, id);
    if (!current) throw new StaffError("not_found", "This person is no longer on the staff list");
    const name = change.name === undefined ? current.name : cleanName(change.name);
    const role = change.role === undefined ? current.role : checkRole(change.role);
    const active = change.active ?? current.active;
    const wasOwner = current.role === "owner" && current.active;
    if (wasOwner && (role !== "owner" || !active) && activeOwnerCount(db) <= 1) {
      throw new StaffError("last_owner", "The cafe needs at least one owner");
    }
    db.run("UPDATE staff SET name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?", [name, role, active ? 1 : 0, now, id]);
  });
  dataChanged();
  return getStaff(db, id)!;
}

export function setStaffPinHash(db: SqlDriver, id: string, pinHash: string, now: number): void {
  db.transaction(() => {
    if (!getStaff(db, id)) throw new StaffError("not_found", "This person is no longer on the staff list");
    db.run("UPDATE staff SET pin_hash = ?, updated_at = ? WHERE id = ?", [pinHash, now, id]);
  });
  dataChanged();
}

export function hasActiveOwner(db: SqlDriver): boolean {
  return activeOwnerCount(db) > 0;
}
