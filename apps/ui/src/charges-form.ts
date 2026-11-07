/** Service charge percent typed in Bill settings to basis points: rounded, kept within 0-20%, blank or invalid as 0. */
export function percentToBp(value: string | number): number {
  const bp = Math.round(Number(value) * 100);
  return Number.isFinite(bp) ? Math.min(2000, Math.max(0, bp)) : 0;
}

/** Packaging charge rupees typed in Bill settings to paise: rounded, kept within ₹0-1000, blank or invalid as 0. */
export function rupeesToChargePaise(value: string | number): number {
  const paise = Math.round(Number(value) * 100);
  return Number.isFinite(paise) ? Math.min(100000, Math.max(0, paise)) : 0;
}

/** The note under a charge box when the typed value is out of range and will be saved as the nearest limit. */
export function chargeInputNote(text: string, max: number, unit: "%" | "₹"): string | null {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) return null;
  const amount = (n: number) => unit === "%" ? `${n}%` : `₹${n}`;
  if (value > max) return `The most is ${amount(max)}; ${amount(max)} will be saved.`;
  if (value < 0) return "Can't be below 0; 0 will be saved.";
  return null;
}

/** Whether a charge box keeps what was typed ("", "2.") because it still converts to the saved value. */
export function keepChargeDraft(text: string, saved: number, convert: (text: string) => number): boolean {
  return convert(text) === saved;
}

/** The billing panel's "Service charge" box: dine-in orders still open, once a preview showed a service charge or while it is unticked. */
export function showServiceChargeBox(o: { billed: boolean; open: boolean; orderType: string; serviceDue: boolean; serviceCharge: boolean }): boolean {
  return !o.billed && o.open && o.orderType === "dine_in" && (o.serviceDue || !o.serviceCharge);
}
