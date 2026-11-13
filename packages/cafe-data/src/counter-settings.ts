import { z } from "zod";
import type { SqlDriver } from "./driver.js";
import { dataChanged } from "./events.js";

export interface CounterSettings {
  cashierDiscountBp: number; lockAfterMinutes: number; kitchenSlip: "off" | "kitchen" | "receipt"; showServedBy: boolean;
}

export const LOCK_MINUTES = [0, 1, 2, 5, 10, 15, 30] as const;
const DEFAULTS: CounterSettings = { cashierDiscountBp: 0, lockAfterMinutes: 5, kitchenSlip: "off", showServedBy: false };

/** The cashier's discount limit (basis points), the idle lock (0 = never), the kitchen slip and whether receipts name the server. */
export const CounterSettingsInput: z.ZodType<CounterSettings> = z.object({
  cashierDiscountBp: z.number().int().min(0, "The limit cannot be below 0%").max(10000, "The limit cannot be above 100%"),
  lockAfterMinutes: z.number().int().refine((m) => (LOCK_MINUTES as readonly number[]).includes(m), "Choose a lock time from the list"),
  kitchenSlip: z.enum(["off", "kitchen", "receipt"]),
  showServedBy: z.boolean(),
});

interface Row { cashier_discount_bp: number; lock_after_minutes: number; kitchen_slip: CounterSettings["kitchenSlip"]; show_served_by: number }

/** The saved settings, or the defaults when the cafe is not set up yet. */
export function getCounterSettings(db: SqlDriver): CounterSettings {
  const r = db.get<Row>(
    "SELECT cashier_discount_bp, lock_after_minutes, kitchen_slip, show_served_by FROM cafe WHERE deleted_at IS NULL LIMIT 1");
  if (!r) return { ...DEFAULTS };
  return { cashierDiscountBp: r.cashier_discount_bp, lockAfterMinutes: r.lock_after_minutes, kitchenSlip: r.kitchen_slip,
    showServedBy: r.show_served_by === 1 };
}

/** Saves onto the cafe row; throws a ZodError for bad input and an Error when the cafe is not set up. */
export function saveCounterSettings(db: SqlDriver, input: unknown, now: number): CounterSettings {
  const s = CounterSettingsInput.parse(input);
  db.transaction(() => {
    if (!db.get("SELECT id FROM cafe WHERE deleted_at IS NULL")) throw new Error("Set up the cafe first");
    db.run(`UPDATE cafe SET cashier_discount_bp = ?, lock_after_minutes = ?, kitchen_slip = ?, show_served_by = ?, updated_at = ?
      WHERE deleted_at IS NULL`, [s.cashierDiscountBp, s.lockAfterMinutes, s.kitchenSlip, s.showServedBy ? 1 : 0, now]);
  });
  dataChanged();
  return s;
}
