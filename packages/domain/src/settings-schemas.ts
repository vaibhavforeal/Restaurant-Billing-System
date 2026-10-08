import { z } from "zod";

/** Empty disables QR payments. Validate syntax only; bank ownership is not verified. */
export const UpiId = z.string().trim().max(255).refine(
  (value) => value === "" || /^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z][a-zA-Z0-9.-]*$/.test(value),
  "Enter a valid UPI ID, such as restaurant@bank, or leave it blank",
);

/** Full-replace shape for the settings singleton (PUT). GSTIN is 15 chars, FSSAI 14 — light caps, empty allowed (unregistered restaurants). */
export const SettingsUpdate = z.object({
  upiId: UpiId.optional(),
  taxInclusive: z.boolean().optional(),
  restaurantName: z.string().trim().min(1),
  address: z.string().trim().max(500).default(""),
  gstin: z.string().trim().max(15).default(""),
  fssai: z.string().trim().max(14).default(""),
  receiptFooter: z.string().trim().max(500).default(""),
});
export type SettingsUpdateInput = z.infer<typeof SettingsUpdate>;
