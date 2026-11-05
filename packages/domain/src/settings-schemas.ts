import { z } from "zod";
import { RECEIPT_STYLES } from "./receipt-styles.js";
import { DEFAULT_GST_RATES, GST_MODES } from "./gst.js";
import { GSTIN_STATE_MESSAGE, gstinMatchesState } from "./restaurant-profile.js";
import { OptionalGstin } from "./gstin-schema.js";
import { billTextLinesSchema } from "./bill-print.js";
import { InvoicePrefix } from "./invoice-numbers.js";
import { ROUND_OFF_MODES } from "./round-off.js";
import { Fssai, Gstin, Phone, Pincode, StateCode } from "./restaurant-profile-schema.js";

/** Empty disables QR payments. Validate syntax only; bank ownership is not verified. */
export const UpiId = z.string().trim().max(255).refine(
  (value) => value === "" || /^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z][a-zA-Z0-9.-]*$/.test(value),
  "Enter a valid UPI ID, such as restaurant@bank, or leave it blank",
);

const DefaultRate = z.literal(DEFAULT_GST_RATES, "GST rate must be 5, 12 or 18");

/** Full-replace shape for the settings singleton (PUT). GSTIN is 15 chars, FSSAI 14 — light caps, empty allowed (unregistered restaurants). */
export const SettingsUpdate = z.object({
  receiptStyle: z.enum(RECEIPT_STYLES).optional(),
  gstMode: z.enum(GST_MODES).optional(),
  gstRate: DefaultRate.optional(),
  upiId: UpiId.optional(),
  restaurantName: z.string().trim().min(1),
  address: z.string().trim().max(500).default(""),
  city: z.string().trim().min(1, "Enter the city").max(80).optional(),
  stateCode: StateCode.optional(),
  pincode: Pincode.optional(),
  phone: Phone.optional(),
  gstin: Gstin.default(""),
  fssai: Fssai.default(""),
  /** Up to 3 lines under the restaurant name on every bill. */
  receiptHeader: billTextLinesSchema("Header lines").default(""),
  receiptFooter: billTextLinesSchema("Footer lines").default(""),
  /** Printed before the financial year in invoice numbers; empty for none. */
  invoicePrefix: InvoicePrefix.optional(),
  /** How a bill total is rounded: to the rupee, to 50 paise, or not at all. */
  roundOff: z.enum(ROUND_OFF_MODES).optional(),
  /** Optional bill lines; GSTIN is never hideable. */
  billShowFssai: z.boolean().optional(),
  billShowCustomer: z.boolean().optional(),
  billShowTable: z.boolean().optional(),
  billShowServedBy: z.boolean().optional(),
  billShowItemGst: z.boolean().optional(),
  /** Whether a KOT edit prints a slip to the kitchen: staff choose ('ask'), or always / never. */
  kotEditPrint: z.enum(["ask", "always", "never"]).optional(),
  /** Hold orders: Hold saves the cart for every device, and dishes can be held back from the kitchen. */
  holdOrdersEnabled: z.boolean().optional(),
  /** Popular items: badge each category's best-seller on the staff and guest menus. */
  popularItemsEnabled: z.boolean().optional(),
  /** Popular follows the clock: each category's best-seller around this hour, else all day. */
  popularByTimeEnabled: z.boolean().optional(),
  /** Ordered together: the carts suggest dishes often on the same bill. */
  orderedTogetherEnabled: z.boolean().optional(),
  /** Customer's usual: offer a known customer's regular dishes and last order on the order screen. */
  customerUsualEnabled: z.boolean().optional(),
  /** The SAC code printed on tax invoices and used in the GSTR-1 HSN summary; 996331 is restaurant service. */
  sacCode: z.string().trim().regex(/^\d{4,8}$/, "Enter a 4 to 8 digit SAC code").optional(),
  /** Zomato's GSTIN in the restaurant's state, for GSTR-1 Table 14 (supplies where Zomato pays the GST). Empty when not known. */
  zomatoGstin: OptionalGstin.optional(),
}).superRefine((s, ctx) => {
  if (s.stateCode !== undefined && s.zomatoGstin && !gstinMatchesState(s.zomatoGstin, s.stateCode)) {
    ctx.addIssue({ code: "custom", path: ["zomatoGstin"], message: "Use Zomato's GSTIN for your state" });
  }
  if (s.stateCode !== undefined && !gstinMatchesState(s.gstin, s.stateCode)) ctx.addIssue({ code: "custom", path: ["gstin"], message: GSTIN_STATE_MESSAGE });
});
export type SettingsUpdateInput = z.infer<typeof SettingsUpdate>;
