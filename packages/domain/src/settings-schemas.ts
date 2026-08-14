import { z } from "zod";

/** Full-replace shape for the settings singleton (PUT). GSTIN is 15 chars, FSSAI 14 — light caps, empty allowed (unregistered restaurants). */
export const SettingsUpdate = z.object({
  restaurantName: z.string().trim().min(1),
  address: z.string().trim().max(500).default(""),
  gstin: z.string().trim().max(15).default(""),
  fssai: z.string().trim().max(14).default(""),
  receiptFooter: z.string().trim().max(500).default(""),
});
export type SettingsUpdateInput = z.infer<typeof SettingsUpdate>;
