import { readPreference, savePreference } from "./pos-shortcuts";

export type PaymentMode = "cash" | "card" | "upi";
/** "last" starts each bill on the method used last on this device; a method always starts on that one. */
export type PaymentStart = PaymentMode | "last";

export const PAYMENT_LAST_KEY = "masalapos.payment-mode";
export const PAYMENT_START_KEY = "masalapos.payment-start";
export const RECEIPT_PRINTER_KEY = "masalapos.receipt-printer";

const isMode = (value: string): value is PaymentMode => value === "cash" || value === "card" || value === "upi";

export function startingPayment(start: PaymentStart, lastUsed: string): PaymentMode {
  if (start !== "last") return start;
  return isMode(lastUsed) ? lastUsed : "cash";
}

export function readPaymentStart(): PaymentStart {
  const value = readPreference(PAYMENT_START_KEY, "last");
  return isMode(value) ? value : "last";
}

export function savePaymentStart(start: PaymentStart) {
  savePreference(PAYMENT_START_KEY, start);
}

/** The payment method a new bill opens on at this counter. */
export function preferredPayment(): PaymentMode {
  return startingPayment(readPaymentStart(), readPreference(PAYMENT_LAST_KEY, "cash"));
}

/** The preferred method if the counter takes it (Settings → Bill settings), else the first one it does. */
export function allowedPayment(preferred: PaymentMode, allowed: readonly PaymentMode[]): PaymentMode {
  return allowed.length === 0 || allowed.includes(preferred) ? preferred : allowed[0]!;
}

export function rememberPayment(mode: PaymentMode) {
  savePreference(PAYMENT_LAST_KEY, mode);
}
