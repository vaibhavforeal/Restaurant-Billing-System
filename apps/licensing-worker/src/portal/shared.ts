// Shared by the portal Worker code and the portal web app (imported there through the `@shared` alias): roles, GST states and money.
// Plain TypeScript only, no Worker or DOM APIs.

export const ROLES = ["admin", "sales", "accounts", "support"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_NAMES: Record<Role, string> = { admin: "Admin", sales: "Sales", accounts: "Accounts", support: "Support" };

/** What each role may do in the portal. Sales reps are further limited to their own customers, leads and orders by the server. */
export const PERMISSIONS = {
  "users.manage": ["admin"],
  "settings.manage": ["admin"],
  "activity.read": ["admin"],
  "customers.read": ["admin", "sales", "accounts", "support"],
  "customers.write": ["admin", "sales"],
  "orders.read": ["admin", "sales", "accounts", "support"],
  "orders.write": ["admin", "sales"],
  "orders.approve": ["admin"],
  "payments.record": ["admin", "accounts"],
  "invoices.issue": ["admin", "accounts"],
  "invoices.cancel": ["admin"],
  "licences.manage": ["admin"],
  "installations.support": ["admin", "support"],
  "leads.read": ["admin", "sales"],
  "leads.write": ["admin", "sales"],
  "followups.write": ["admin", "sales", "support"],
  "tickets.read": ["admin", "sales", "support"],
  "tickets.write": ["admin", "support"],
  "reports.read": ["admin", "sales", "accounts", "support"],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;
export const roleCan = (role: Role, permission: Permission): boolean => (PERMISSIONS[permission] as readonly Role[]).includes(role);
/** Sales reps see only the customers, leads, orders and follow-ups assigned to them. */
export const seesOnlyOwn = (role: Role): boolean => role === "sales";

/** GST state and union-territory codes (the first two digits of a GSTIN). */
export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
  "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
  "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra",
  "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};

/** A GSTIN's shape: state code, PAN, entity number, Z, check character. The check character itself is not verified. */
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** "Rs. 1,23,456.00": Indian digit grouping. Invoices use "Rs." because their PDF font has no rupee sign. */
export function formatPaise(paise: number, prefix = "Rs. "): string {
  const negative = paise < 0, abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100).toString(), fraction = (abs % 100).toString().padStart(2, "0");
  const grouped = rupees.length <= 3 ? rupees : `${rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${rupees.slice(-3)}`;
  return `${negative ? "-" : ""}${prefix}${grouped}.${fraction}`;
}

/** Rupees typed by a person ("1,499.50") to paise, or null when it is not an amount. */
export function parseRupees(text: string): number | null {
  const clean = text.replace(/[,\s]/g, "").replace(/^(rs\.?|₹)/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, fraction = ""] = clean.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** A priced line before GST. Rates are in basis points: 1800 is 18%. */
export interface PricedLine { quantity: number; unitPricePaise: number; discountPaise: number; gstRateBp: number }
export interface TaxedLine { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }
export interface Totals { lines: TaxedLine[]; subtotalPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; taxPaise: number; totalPaise: number }

/** Half up to the paisa. */
const round = (value: number) => Math.floor(value + 0.5);

/**
 * GST on each line, then the order's totals as the sum of the lines as shown. Within the seller's state the tax is CGST and SGST,
 * each half the rate on the line's taxable value; otherwise one IGST at the full rate.
 */
export function computeTotals(lines: PricedLine[], intraState: boolean): Totals {
  const taxed = lines.map((l) => {
    const taxablePaise = Math.max(0, l.quantity * l.unitPricePaise - l.discountPaise);
    const half = round((taxablePaise * l.gstRateBp) / 20_000);
    return intraState ? { taxablePaise, cgstPaise: half, sgstPaise: half, igstPaise: 0 } : { taxablePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: round((taxablePaise * l.gstRateBp) / 10_000) };
  });
  const sum = (key: keyof TaxedLine) => taxed.reduce((total, l) => total + l[key], 0);
  const subtotalPaise = sum("taxablePaise"), cgstPaise = sum("cgstPaise"), sgstPaise = sum("sgstPaise"), igstPaise = sum("igstPaise");
  const taxPaise = cgstPaise + sgstPaise + igstPaise;
  return { lines: taxed, subtotalPaise, cgstPaise, sgstPaise, igstPaise, taxPaise, totalPaise: subtotalPaise + taxPaise };
}

/** The buyer's GST state: from their GSTIN when they have one, else the state on their address. */
export const buyerState = (customer: { gstin: string | null; stateCode: string | null }) => customer.gstin?.slice(0, 2) || customer.stateCode || null;

export const PLAN_NAMES = { basic: "Basic", pro: "Pro" } as const;
export const termLabel = (o: { termMonths: number | null; termDays: number | null }) =>
  o.termDays !== null ? `${o.termDays} days` : o.termMonths === 1 ? "1 month" : o.termMonths! % 12 === 0 ? (o.termMonths === 12 ? "1 year" : `${o.termMonths! / 12} years`) : `${o.termMonths} months`;

/** Devices each plan includes per outlet; the same numbers as PLANS in @forkflow/domain/licensing (a test keeps them equal). */
export const PLAN_DEVICES = { basic: 2, pro: 5 } as const;

export interface DraftLine extends PricedLine { kind: "licence" | "extra"; description: string; sac: string }
export interface OrderChoices {
  kind: "new" | "renewal" | "trial"; plan: "basic" | "pro"; termMonths: number; outlets: number; maxDevices: number;
  pricePerOutletPaise: number; discountPaise: number; extras: Array<{ description: string; sac: string; quantity: number; unitPricePaise: number }>;
  installationIds: string[];
}

/**
 * An order's invoice lines from what staff chose: the licence per outlet (or per renewed counter), extra devices beyond the plan's,
 * then any extra lines, all at the settings' GST rate. A trial has no lines. The portal's preview and the Worker both use this.
 */
export function draftLines(o: OrderChoices, settings: { invoice: { sac: string; gstRateBp: number }; extraDevicePaise: number }): DraftLine[] {
  if (o.kind === "trial") return [];
  const renewal = o.kind === "renewal";
  const quantity = renewal ? o.installationIds.length : o.outlets;
  const term = termLabel({ termMonths: o.termMonths, termDays: null });
  const { sac, gstRateBp } = settings.invoice;
  const lines: DraftLine[] = [{
    kind: "licence", description: `ForkFlow ${PLAN_NAMES[o.plan]} licence${renewal ? " renewal" : ""}, ${term}, per outlet`, sac,
    quantity, unitPricePaise: o.pricePerOutletPaise, discountPaise: o.discountPaise, gstRateBp,
  }];
  const extraDevices = o.maxDevices - PLAN_DEVICES[o.plan];
  if (extraDevices > 0 && settings.extraDevicePaise > 0 && quantity > 0) lines.push({
    kind: "licence", description: `Extra devices beyond the plan's ${PLAN_DEVICES[o.plan]}, ${term}`, sac,
    quantity: quantity * extraDevices, unitPricePaise: settings.extraDevicePaise, discountPaise: 0, gstRateBp,
  });
  for (const extra of o.extras) lines.push({ kind: "extra", ...extra, discountPaise: 0, gstRateBp });
  return lines;
}
