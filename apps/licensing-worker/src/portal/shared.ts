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
