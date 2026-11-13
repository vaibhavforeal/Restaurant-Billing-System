import type { TaxLine } from "@masalapos/domain/billing";
import { listBills } from "./bills.js";
import type { SqlDriver } from "./driver.js";

export interface DaySummary {
  date: string; billCount: number; voidCount: number;
  /** Sum of subtotals of live bills. */
  grossPaise: number;
  discountPaise: number; roundingPaise: number;
  /** Sum of totals of live bills. */
  netPaise: number;
  /** Merged by rate, ascending. */
  taxes: TaxLine[];
  byMode: { cash: number; upi: number; card: number };
  /** By amount, largest first, then name. Custom lines with the same name add together. */
  items: Array<{ name: string; qty: number; amountPaise: number }>;
  voids: Array<{ invoiceNo: string; token: number; totalPaise: number; reason: string }>;
}

/** One day's figures. A voided bill counts under the day it was billed, in `voids` only. */
export function daySummary(db: SqlDriver, businessDate: string): DaySummary {
  const bills = [...listBills(db, businessDate)].reverse();
  const live = bills.filter((b) => !b.voided);
  const taxes = new Map<number, TaxLine>();
  const byMode = { cash: 0, upi: 0, card: 0 };
  const items = new Map<string, { name: string; qty: number; amountPaise: number }>();
  for (const bill of live) {
    for (const t of bill.taxes) {
      const sum = taxes.get(t.gstRate) ?? { gstRate: t.gstRate, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 };
      taxes.set(t.gstRate, { gstRate: t.gstRate, taxablePaise: sum.taxablePaise + t.taxablePaise, cgstPaise: sum.cgstPaise + t.cgstPaise,
        sgstPaise: sum.sgstPaise + t.sgstPaise });
    }
    for (const p of bill.payments) if (p.mode === "cash" || p.mode === "upi" || p.mode === "card") byMode[p.mode] += p.amountPaise;
    for (const line of bill.receipt.items) {
      const row = items.get(line.name) ?? { name: line.name, qty: 0, amountPaise: 0 };
      items.set(line.name, { name: line.name, qty: row.qty + line.qty, amountPaise: row.amountPaise + line.pricePaise * line.qty });
    }
  }
  const sum = (pick: (b: (typeof live)[number]) => number) => live.reduce((n, b) => n + pick(b), 0);
  return {
    date: businessDate, billCount: live.length, voidCount: bills.length - live.length,
    grossPaise: sum((b) => b.subtotalPaise), discountPaise: sum((b) => b.discountPaise), roundingPaise: sum((b) => b.roundingPaise),
    netPaise: sum((b) => b.totalPaise),
    taxes: [...taxes.values()].sort((a, b) => a.gstRate - b.gstRate),
    byMode,
    items: [...items.values()].sort((a, b) => b.amountPaise - a.amountPaise || a.name.localeCompare(b.name)),
    voids: bills.filter((b) => b.voided).map((b) => ({ invoiceNo: b.invoiceNo, token: b.token, totalPaise: b.totalPaise, reason: b.voided!.reason })),
  };
}
