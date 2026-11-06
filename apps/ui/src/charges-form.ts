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

/** The billing panel's "Service charge" box: dine-in orders still open, once a preview showed a service charge or while it is unticked. */
export function showServiceChargeBox(o: { billed: boolean; open: boolean; orderType: string; serviceDue: boolean; serviceCharge: boolean }): boolean {
  return !o.billed && o.open && o.orderType === "dine_in" && (o.serviceDue || !o.serviceCharge);
}
