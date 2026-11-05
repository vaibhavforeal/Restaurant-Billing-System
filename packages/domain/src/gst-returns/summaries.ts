import { addRates, byRate, cancelledInPeriod, sumRates, type GstBillFact, type GstCreditNoteFact, type RateLine } from "./facts.js";
import type { Gstr1Summary } from "./gstr1.js";

export interface Gstr3bSummary {
  /** 3.1(a): outward taxable supplies (other than zero rated, nil rated and exempted). */
  outwardTaxable: RateLine;
  /** 3.1(c): nil rated and exempted supplies. */
  nilPaise: number;
  /** 3.1.1(ii): supplies through an e-commerce operator that pays the tax under section 9(5). */
  eco95Paise: number;
}

/** The GSTR-3B Table 3.1 figures that come from the restaurant's sales; input tax credit is not tracked by the POS. */
export function gstr3bSummary(s: Gstr1Summary): Gstr3bSummary {
  const sales = [...s.b2b.flatMap((g) => g.invoices.flatMap((i) => i.items)), ...s.b2cs];
  const credits = s.cdnr.flatMap((g) => g.notes.flatMap((n) => n.items));
  const out = sumRates(sales), cn = sumRates(credits);
  return {
    outwardTaxable: { gstRate: 0, taxablePaise: out.taxablePaise - cn.taxablePaise, cgstPaise: out.cgstPaise - cn.cgstPaise, sgstPaise: out.sgstPaise - cn.sgstPaise },
    nilPaise: s.nil.b2bPaise + s.nil.b2cPaise,
    eco95Paise: s.eco95.valuePaise,
  };
}

/** Composition tax for a restaurant: 5% of turnover, half CGST and half SGST. */
export const COMPOSITION_RATE = 5;
export interface Cmp08Month { month: string; turnoverPaise: number; creditPaise: number; netPaise: number; cgstPaise: number; sgstPaise: number }
export interface Cmp08Summary { months: Cmp08Month[]; total: Omit<Cmp08Month, "month">; eco95Paise: number; billCount: number; cancelledCount: number }

/**
 * CMP-08 for a composition restaurant: turnover from bills of supply, less credit notes, by month, and the composition tax on it.
 * Bills issued and voided in the same period are left out. Zomato supplies are shown apart: Zomato pays their GST.
 */
export function cmp08Summary(bills: GstBillFact[], creditNotes: GstCreditNoteFact[], months: string[]): Cmp08Summary {
  const cancelled = cancelledInPeriod(bills, creditNotes);
  const own = bills.filter((b) => b.supply === "composition" && !cancelled.has(b.billId));
  const notes = creditNotes.filter((n) => n.supply === "composition" && !cancelled.has(n.billId));
  const taxable = (lines: RateLine[]) => lines.reduce((s, l) => s + l.taxablePaise, 0);
  const tax = (net: number) => Math.round(net * COMPOSITION_RATE / 200);
  const rows = months.map((month) => {
    const turnoverPaise = own.filter((b) => b.dateKey.startsWith(month)).reduce((s, b) => s + taxable(b.taxes), 0);
    const creditPaise = notes.filter((n) => n.dateKey.startsWith(month)).reduce((s, n) => s + taxable(n.taxes), 0);
    const netPaise = turnoverPaise - creditPaise;
    return { month, turnoverPaise, creditPaise, netPaise, cgstPaise: tax(netPaise), sgstPaise: tax(netPaise) };
  });
  const sum = (key: keyof Omit<Cmp08Month, "month">) => rows.reduce((s, r) => s + r[key], 0);
  const netPaise = sum("netPaise");
  return {
    months: rows,
    total: { turnoverPaise: sum("turnoverPaise"), creditPaise: sum("creditPaise"), netPaise, cgstPaise: tax(netPaise), sgstPaise: tax(netPaise) },
    eco95Paise: bills.filter((b) => b.supply === "eco95").reduce((s, b) => s + taxable(b.taxes), 0),
    billCount: own.length, cancelledCount: cancelled.size,
  };
}

/** Per-rate totals of a set of lines, for display. */
export const rateTotals = (lines: RateLine[]) => byRate(addRates(new Map(), lines));
