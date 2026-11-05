import type { OperationalReport, ReportCell, ReportColumn } from "./operational-reports.js";

export type ActivityKind = "cancelled_after_kot" | "kot_cut" | "credit_note" | "discount" | "cash_short" | "pay_out" | "stock_correction";

/** One thing a staff member did that can lose the restaurant money, as the server read it. */
export interface ActivityEvent {
  kind: ActivityKind;
  at: number;
  staffId: string;
  staffName: string;
  /** Items for cancellations and KOT cuts; 1 for everything else. */
  count: number;
  amountPaise: number | null;
  detail: string;
  /** "Bill #1042", "KOT #12", or null. */
  reference: string | null;
  /** A void of a bill that had been paid. */
  paidBillVoid?: boolean;
  /** A discount's share of the bill's subtotal, in percent. */
  discountPercent?: number;
}

export interface ActivityThresholds {
  /** Cash short at shift close of at least this much is always flagged. */
  cashShortPaise: number;
  /** A discount of at least this percent of the bill is always flagged. */
  discountPercent: number;
  /** A single pay-out over this much is always flagged. */
  payOutPaise: number;
  /** A count is unusual at this many times the usual daily rate... */
  multiplier: number;
  /** ...and only with at least this many events. */
  minEvents: number;
}

export const DEFAULT_ACTIVITY_THRESHOLDS: ActivityThresholds = { cashShortPaise: 20_000, discountPercent: 20, payOutPaise: 50_000, multiplier: 2, minEvents: 3 };

export type StaffActivityReport = Omit<OperationalReport, "kind"> & { kind: "staff-activity" };

const LABELS: Record<ActivityKind, string> = {
  cancelled_after_kot: "Cancelled after KOT", kot_cut: "KOT quantity cut", credit_note: "Void or refund", discount: "Discount",
  cash_short: "Cash short", pay_out: "Pay-out", stock_correction: "Wastage or count correction",
};
/** Kinds compared with the usual rate, and what their count is made of. Cash short is judged by amount only. */
const RATE_UNITS: Partial<Record<ActivityKind, string>> = {
  cancelled_after_kot: "items", kot_cut: "items", credit_note: "times", discount: "times", pay_out: "times", stock_correction: "times",
};

const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
/** One decimal, or two below 0.1 so a rare event never reads as "0 a day". */
const rate = (value: number) => value < 0.1 ? String(Math.round(value * 100) / 100) : String(Math.round(value * 10) / 10);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const column = (key: string, label: string, format?: ReportColumn["format"]): ReportColumn => format ? { key, label, format } : { key, label };

/**
 * Staff activity: what each person did that can lose money (cancellations after KOT, KOT cuts, voids and refunds,
 * discounts, cash short, pay-outs, wastage and count corrections), with flags. Always flagged: a paid bill voided, cash
 * short, a discount or a pay-out at the thresholds. Unusual: a person's count per day in these dates at least
 * `multiplier` times their own daily rate over the baseline days before (or, with no history of their own, the
 * restaurant's rate per person), with at least `minEvents` events.
 */
export function buildStaffActivityReport(input: {
  from: string; to: string; today: string; timezone: string; generatedAt: number;
  days: number; baselineDays: number; events: ActivityEvent[]; baseline: ActivityEvent[]; thresholds: ActivityThresholds;
}): StaffActivityReport {
  const { events, baseline, thresholds: t, days, baselineDays } = input;
  const flags: Array<Record<string, ReportCell> & { at: number }> = [];
  const flag = (event: Pick<ActivityEvent, "at" | "staffName" | "kind" | "detail" | "amountPaise" | "reference">, why: string) =>
    flags.push({ at: event.at, staff: event.staffName, what: LABELS[event.kind], why, detail: event.detail, amount: event.amountPaise, reference: event.reference });

  for (const event of events) {
    if (event.kind === "credit_note" && event.paidBillVoid) flag(event, "Paid bill voided");
    if (event.kind === "cash_short" && (event.amountPaise ?? 0) >= t.cashShortPaise) flag(event, `Cash short by ${rupees(t.cashShortPaise)} or more`);
    if (event.kind === "discount" && (event.discountPercent ?? 0) >= t.discountPercent) flag(event, `Discount of ${t.discountPercent}% or more`);
    if (event.kind === "pay_out" && (event.amountPaise ?? 0) > t.payOutPaise) flag(event, `Pay-out over ${rupees(t.payOutPaise)}`);
  }

  // Usual rates: each person's own, and the restaurant's per person (over everyone active in the baseline).
  const sum = (list: ActivityEvent[]) => list.reduce((total, e) => total + e.count, 0);
  const baselineStaff = new Set(baseline.map((e) => e.staffId)).size;
  for (const kind of Object.keys(RATE_UNITS) as ActivityKind[]) {
    const ofKind = events.filter((e) => e.kind === kind);
    for (const staffId of new Set(ofKind.map((e) => e.staffId))) {
      const mine = ofKind.filter((e) => e.staffId === staffId);
      const count = sum(mine);
      if (count < t.minEvents) continue;
      const own = sum(baseline.filter((e) => e.kind === kind && e.staffId === staffId));
      const everyone = sum(baseline.filter((e) => e.kind === kind));
      const hasOwnHistory = baseline.some((e) => e.staffId === staffId);
      const usual = hasOwnHistory ? own / baselineDays : baselineStaff ? everyone / baselineDays / baselineStaff : 0;
      if (count / days < t.multiplier * usual) continue;
      const span = `${count} ${RATE_UNITS[kind]} in ${plural(days, "day")}`;
      const compared = usual === 0 ? `none in the ${baselineDays} days before`
        : hasOwnHistory ? `usually ${rate(usual)} a day over the ${baselineDays} days before`
        : `the restaurant's usual is ${rate(usual)} a day per person over the ${baselineDays} days before`;
      const amounts = mine.filter((e) => e.amountPaise !== null);
      flag({ at: Math.max(...mine.map((e) => e.at)), staffName: mine[0]!.staffName, kind, detail: `${span}; ${compared}`,
        amountPaise: amounts.length ? amounts.reduce((total, e) => total + e.amountPaise!, 0) : null, reference: null }, `${t.multiplier}× usual or more`);
    }
  }
  flags.sort((a, b) => b.at - a.at);

  const staffRows = new Map<string, Record<string, ReportCell>>();
  for (const event of events) {
    const row = staffRows.get(event.staffId) ?? { staff: event.staffName, cancelled: 0, kotCuts: 0, creditNotes: 0, creditPaise: 0, discounts: 0, discountPaise: 0, cashShortPaise: 0, payOutPaise: 0, stockCorrections: 0, flags: 0 };
    const add = (key: string, value: number) => { row[key] = (row[key] as number) + value; };
    const amount = event.amountPaise ?? 0;
    if (event.kind === "cancelled_after_kot") add("cancelled", event.count);
    if (event.kind === "kot_cut") add("kotCuts", event.count);
    if (event.kind === "credit_note") { add("creditNotes", 1); add("creditPaise", amount); }
    if (event.kind === "discount") { add("discounts", 1); add("discountPaise", amount); }
    if (event.kind === "cash_short") add("cashShortPaise", amount);
    if (event.kind === "pay_out") add("payOutPaise", amount);
    if (event.kind === "stock_correction") add("stockCorrections", 1);
    staffRows.set(event.staffId, row);
  }
  for (const row of staffRows.values()) row.flags = flags.filter((f) => f.staff === row.staff).length;
  const staff = [...staffRows.values()].sort((a, b) => String(a.staff).localeCompare(String(b.staff)));
  const numericKeys = ["cancelled", "kotCuts", "creditNotes", "creditPaise", "discounts", "discountPaise", "cashShortPaise", "payOutPaise", "stockCorrections", "flags"];
  const totals: Record<string, ReportCell> = { staff: "All staff", ...Object.fromEntries(numericKeys.map((key) => [key, staff.reduce((total, row) => total + (row[key] as number), 0)])) };

  const notes = [
    `Always flagged: a paid bill voided, cash short by ${rupees(t.cashShortPaise)} or more, a discount of ${t.discountPercent}% or more of the bill, a pay-out over ${rupees(t.payOutPaise)}.`,
    `Unusual: a person's count per day in these dates at least ${t.multiplier}× their own daily rate over the ${baselineDays} days before (or the restaurant's rate per person if they have no history there), with at least ${t.minEvents} events. Admins can change these limits in Settings.`,
    "Voids, refunds and discounts name who asked and who approved. A flag is a prompt to look, not proof of wrongdoing.",
  ];
  if (!events.length) notes.push("No cancellations, KOT cuts, voids, refunds, discounts, cash differences, pay-outs or stock corrections in these dates.");
  return {
    kind: "staff-activity", from: input.from, to: input.to, today: input.today, timezone: input.timezone, generatedAt: input.generatedAt, notes,
    tables: [
      { title: "Flagged", columns: [column("at", "When", "time"), column("staff", "Staff"), column("what", "What"), column("why", "Why flagged"), column("detail", "Detail"), column("amount", "Amount", "money"), column("reference", "Reference")],
        rows: flags.map(({ at, ...row }) => ({ at, ...row })) },
      { title: "By staff", columns: [column("staff", "Staff"), column("cancelled", "Cancelled after KOT (items)", "quantity"), column("kotCuts", "KOT cuts (items)", "quantity"),
        column("creditNotes", "Voids & refunds (count)", "quantity"), column("creditPaise", "Voids & refunds (value)", "money"), column("discounts", "Discounts (count)", "quantity"), column("discountPaise", "Discounts (value)", "money"),
        column("cashShortPaise", "Cash short", "money"), column("payOutPaise", "Pay-outs", "money"), column("stockCorrections", "Wastage & corrections", "quantity"), column("flags", "Flags", "quantity")],
        rows: staff, totals },
    ],
  };
}
