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
