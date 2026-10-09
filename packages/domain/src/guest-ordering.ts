import { z } from "zod";

export const GuestSubmission = z.object({
  clientRef: z.string().uuid(),
  receiptToken: z.string().regex(/^[a-f0-9]{64}$/),
  menuVersion: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(z.object({
    productId: z.string().uuid(), variantId: z.string().uuid().nullable(),
    qty: z.number().int().min(1).max(20), note: z.string().trim().max(200)
      .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value), "Instructions contain unsupported control characters").default(""),
  }).strict()).min(1).max(30),
}).strict();
export type GuestSubmission = z.infer<typeof GuestSubmission>;
export interface GuestMenu {
  restaurantName: string;
  table: { id: string; name: string; area: string | null };
  orderingAvailable: boolean;
  menuVersion: string;
  categories: Array<{ id: string; name: string }>;
  products: Array<{ id: string; categoryId: string; name: string; description: string; isSoldOut: boolean; photoUrl: string | null; pricePaise: number; gstRate: number; isVeg: boolean;
    variants: Array<{ id: string; name: string; pricePaise: number }> }>;
}
export interface GuestRequestItem {
  productId: string; variantId: string | null; name: string; pricePaise: number; gstRate: number; qty: number; note: string;
}
export interface GuestReceipt {
  id: string; status: "pending" | "accepted" | "rejected" | "expired";
  tableName: string; items: GuestRequestItem[]; subtotalPaise: number;
  createdAt: number; expiresAt: number; reason: string | null;
  preparation: GuestPreparation | null;
}
export type PreparationState = "queued" | "preparing" | "ready" | "cancelled" | "with_staff";
export interface GuestPreparation {
  state: PreparationState;
  items: Array<{ name: string; qty: number; state: PreparationState }>;
  hasChanges: boolean;
}
export interface GuestRequest extends GuestReceipt {
  tableId: string; orderId: string | null; reviewedAt: number | null; reviewedByName: string | null;
}
export interface QrTable {
  id: string; name: string; area: string | null; isActive: boolean; enabled: boolean; path: string | null;
}
