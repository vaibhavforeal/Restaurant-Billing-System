// The portal API's request and response shapes, shared with the portal web app (apps/portal imports this file type-only).
// Plain interfaces: no imports beyond shared.ts, so the web app can compile it without the Worker's dependencies.
import type { Role } from "./shared.js";

export interface StaffUser { id: string; email: string; name: string; role: Role; mustChangePassword: boolean }
export interface StaffRecord {
  id: string; email: string; name: string; role: Role; active: boolean; mustChangePassword: boolean;
  locked: boolean; lastLoginAt: number | null; createdAt: number;
}
export interface Colleague { id: string; name: string; role: Role }

export interface ActivityItem {
  id: number; at: number; actor: { id: string; name: string } | null; action: string; entityType: string; entityId: string;
  customer: { id: string; name: string } | null; summary: string;
}
export interface ActivityPage { entries: ActivityItem[]; nextBefore: number | null }

export interface SellerDetails { legalName: string; gstin: string; address: string; city: string; stateCode: string; pincode: string; email: string; phone: string }
export interface PriceRow { plan: "basic" | "pro"; termMonths: number; pricePaise: number }
export interface PortalSettingsData {
  seller: SellerDetails;
  invoice: { prefix: string; sac: string; gstRateBp: number; bankDetails: string; terms: string };
  prices: PriceRow[];
  extraDevicePaise: number;
  trialDays: number;
}

/** Every refusal: plain words for staff, and a code for the app's logic. */
export interface ApiErrorBody { error: string; code?: string }

export interface Ref { id: string; name: string }

export interface CustomerSummary {
  id: string; code: string; businessName: string; contactName: string | null; phone: string | null; email: string | null;
  city: string | null; stateCode: string | null; status: "active" | "inactive"; owner: Ref | null;
  /** Counters holding a seat on one of the customer's orders. */
  outlets: number;
  /** The earliest end date among those counters' licences. */
  nextRenewalAt: number | null;
  createdAt: number;
}
export interface CustomerDetail extends CustomerSummary {
  gstin: string | null; address: string | null; pincode: string | null; notes: string | null; updatedAt: number;
  /** Payments received, and what confirmed orders still owe. */
  paidPaise: number; outstandingPaise: number; orders: number;
}
export interface CustomerInput {
  businessName: string; contactName: string; phone: string; email: string; gstin: string; address: string; city: string; stateCode: string;
  pincode: string; notes: string; ownerId?: string | null; status?: "active" | "inactive";
}

export type OrderKind = "new" | "renewal" | "trial";
export type OrderStatus = "draft" | "confirmed" | "paid" | "cancelled";
export interface OrderLine {
  id: number; kind: "licence" | "extra"; description: string; sac: string; quantity: number; unitPricePaise: number; discountPaise: number;
  gstRateBp: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
}
export interface OrderSummary {
  id: string; code: string; kind: OrderKind; status: OrderStatus; plan: "basic" | "pro"; termMonths: number | null; termDays: number | null;
  outlets: number; seatsUsed: number; totalPaise: number; paidPaise: number; customer: Ref & { code: string }; owner: Ref | null;
  createdAt: number; creditUntil: number | null;
}
export interface LicenceInfo {
  plan: "basic" | "pro"; revision: number; expiresAt: number; graceUntil: number; trial: boolean; maxDevices: number;
  state: "active" | "grace" | "expired";
  /** The counter has collected this revision (it reported it, or was handed it). */
  delivered: boolean;
  orderCode: string | null;
}
export interface InstallationSummary {
  id: string; outletName: string | null; customer: Ref | null; order: { id: string; code: string } | null;
  activatedAt: number | null; lastSeenAt: number | null; appVersion: string | null; createdAt: number;
  licence: LicenceInfo | null;
  /** Holds a seat on an order; false once support releases the seat. */
  enrolled: boolean;
  /** The counter proved it holds its secret; false after support resets the pairing, until it next checks in. */
  paired: boolean;
}
export interface ModuleChoice { id: string; name: string; group: string; description: string; inPlan: boolean; override: boolean | null; allowed: boolean }
export interface InstallationDetail extends InstallationSummary {
  modules: ModuleChoice[]; modulesUpdatedAt: number | null;
  moduleEvents: Array<{ id: number; moduleId: string; allowed: boolean | null; revision: number | null; at: number; actorName: string | null }>;
}
export interface PaymentRecord {
  id: string; amountPaise: number; method: "cash" | "bank" | "upi" | "cheque" | "card" | "razorpay"; reference: string | null;
  status: "pending" | "cleared" | "bounced"; receivedAt: number; recordedBy: Ref | null; note: string | null;
}
export interface PaymentLinkRecord { id: string; shortUrl: string; amountPaise: number; status: string; createdAt: number; expireBy: number | null }
export interface InvoiceSummary { id: string; number: string; issuedAt: number; totalPaise: number; cancelledAt: number | null; customer: Ref; orderId: string; orderCode: string }
export interface OrderDetail extends OrderSummary {
  maxDevices: number; modules: Record<string, boolean>; notes: string | null;
  subtotalPaise: number; taxPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
  /** CGST and SGST (true) or IGST (false); null while the seller's or the customer's state is unknown. */
  intraState: boolean | null;
  lines: OrderLine[];
  confirmedAt: number | null; paidAt: number | null; cancelledAt: number | null; creditApprovedBy: Ref | null;
  /** Counters holding this order's seats (new and trial orders). */
  seats: InstallationSummary[];
  /** Counters this renewal extends. */
  renewalTargets: InstallationSummary[];
  payments: PaymentRecord[]; links: PaymentLinkRecord[]; invoices: InvoiceSummary[];
}
export interface OrderInput {
  customerId: string; kind: OrderKind; plan: "basic" | "pro"; termMonths: number; outlets: number; maxDevices: number;
  modules: Record<string, boolean>; pricePerOutletPaise: number; discountPaise: number;
  extras: Array<{ description: string; sac: string; quantity: number; unitPricePaise: number }>;
  installationIds: string[]; notes: string;
}
export interface SearchHit { kind: "customer" | "order" | "lead" | "ticket"; id: string; title: string; detail: string }
