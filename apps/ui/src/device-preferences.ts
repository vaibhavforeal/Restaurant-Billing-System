import type { PaymentStart } from "@masalapos/domain/devices";
import { readPreference, savePreference } from "./pos-shortcuts";

export type PaymentMode = "cash" | "card" | "upi";
/** "last" starts each bill on the method used last on this device; a method always starts on that one. Set per device on the main PC. */
export type { PaymentStart };

export const PAYMENT_LAST_KEY = "masalapos.payment-mode";

const isMode = (value: string): value is PaymentMode => value === "cash" || value === "card" || value === "upi";

export function startingPayment(start: PaymentStart, lastUsed: string): PaymentMode {
  if (start !== "last") return start;
  return isMode(lastUsed) ? lastUsed : "cash";
}

/** The payment method a new bill opens on: the device's setting, which may be "the one used last in this browser". */
export function preferredPayment(start: PaymentStart): PaymentMode {
  return startingPayment(start, readPreference(PAYMENT_LAST_KEY, "cash"));
}

/** The preferred method if the counter takes it (Settings → Bill settings), else the first one it does. */
export function allowedPayment(preferred: PaymentMode, allowed: readonly PaymentMode[]): PaymentMode {
  return allowed.length === 0 || allowed.includes(preferred) ? preferred : allowed[0]!;
}

export function rememberPayment(mode: PaymentMode) {
  savePreference(PAYMENT_LAST_KEY, mode);
}
