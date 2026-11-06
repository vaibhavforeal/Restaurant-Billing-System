import type { ItemPrices, PriceTier } from "@masalapos/domain/pricing";
import type { DefaultGstRate, GstMode } from "@masalapos/domain/gst";
import type { ReceiptStyle } from "@masalapos/domain/receipt-styles";
import type { RoundOff } from "@masalapos/domain/round-off";
import type { ComboGroup } from "@masalapos/domain/combos";
export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface Variant extends ItemPrices {
  id: string;
  name: string;
  pricePaise: number;
  isActive: boolean;
}

export interface Product extends ItemPrices {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  isSoldOut: boolean;
  photoVersion: string | null;
  photoUrl: string | null;
  pricePaise: number;
  /** null: the item uses the restaurant's default GST rate. */
  gstRate: number | null;
  isVeg: boolean;
  kotStationId: string | null;
  isActive: boolean;
  variants: Variant[];
  /** A combo is sold as one line holding items picked from its slots. */
  kind: "item" | "combo";
  combo?: ComboGroup[];
}

export interface Station {
  id: string;
  name: string;
}

export interface PrinterInfo {
  id: string;
  name: string;
  kind: "network" | "windows" | "bluetooth";
  connection: string;
  paperWidth: 58 | 80;
  isActive: boolean;
  receiptProfile: PrintProfile;
  kotProfile: PrintProfile;
}

export interface PrintProfile { copies: number; feedLines: number; autoCut: boolean }

export interface StationInfo {
  id: string;
  name: string;
  printerId: string | null;
  isActive: boolean;
}

export interface PrintJobInfo {
  id: string;
  printerId: string;
  printerName: string;
  kind: "kot" | "cancel" | "test" | "receipt" | "table" | "credit_note";
  label: string;
  status: "queued" | "printing" | "failed" | "done" | "unknown";
  error: string | null;
  createdAt: number;
  attempts: number;
  copyNumber: number;
  copyCount: number;
}

export interface AdminUser {
  id: string;
  name: string;
  /** What they type to sign in; empty for someone who has never had one. */
  username: string;
  role: "admin" | "cashier" | "waiter" | "kitchen";
  isActive: boolean;
  createdAt: number;
  /** Overrides the role's discount limit; null follows the role. */
  maxDiscountPercent: number | null;
  /** How many permissions differ from the person's role (always 0 for admins). */
  permissionChanges?: number;
}

export interface SettingsData {
  gstMode: GstMode;
  /** The restaurant's default GST rate, used by items without their own rate. Only meaningful when GST is charged (`gstMode` "included" or "exclusive"). */
  gstRate: DefaultGstRate;
  receiptStyle: ReceiptStyle;
  upiId: string;
  restaurantName: string;
  /** The street line; city, state and PIN code are kept apart and joined on bills. */
  address: string;
  city: string;
  /** GST state code, e.g. "29" for Karnataka. */
  stateCode: string;
  pincode: string;
  phone: string;
  gstin: string;
  fssai: string;
  /** Up to 3 lines of 48 characters printed above the bill items. */
  receiptHeader: string;
  receiptFooter: string;
  billShowFssai: boolean;
  billShowCustomer: boolean;
  billShowTable: boolean;
  billShowServedBy: boolean;
  /** Print each item's GST rate; the server only does so on bills that charge GST. */
  billShowItemGst: boolean;
  /** Whether a change to a sent item prints a slip to the kitchen: staff choose, or always / never. */
  kotEditPrint: "ask" | "always" | "never";
  /** Hold orders: Hold saves the cart for every device, and dishes can be held back from the kitchen. */
  holdOrdersEnabled: boolean;
  /** Popular items: badge each category's best-seller on the staff and guest menus. */
  popularItemsEnabled: boolean;
  /** Popular follows the clock: each category's best-seller around this hour, else all day. */
  popularByTimeEnabled: boolean;
  /** Ordered together: the carts suggest dishes often on the same bill. */
  orderedTogetherEnabled: boolean;
  /** Customer's usual: offer a known customer's regular dishes and last order on the order screen. */
  customerUsualEnabled: boolean;
  /** The SAC code on tax invoices and in the GSTR-1 HSN summary; 996331 is restaurant service. */
  sacCode: string;
  /** Zomato's GSTIN in the restaurant's state, for GSTR-1 Table 14. Empty when not known. */
  zomatoGstin: string;
  /** Up to 4 letters or digits before the financial year in invoice numbers; empty for none. */
  invoicePrefix: string;
  /** How a bill total is rounded: to the rupee, to 50 paise, or not at all. */
  roundOff: RoundOff;
  /** Service charge on dine-in bills, in basis points (1000 = 10%); 0 for none. */
  serviceChargeBp: number;
  /** Packaging charge on takeaway and delivery bills, in paise; 0 for none. */
  packagingChargePaise: number;
  serviceChargeLabel: string;
  packagingChargeLabel: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  typeId: string | null;
  typeName: string | null;
  notes: string;
  email: string | null;
  /** `YYYY-MM-DD`, or `--MM-DD` when the year is not known. */
  birthDate: string | null;
  anniversaryDate: string | null;
  gender: "female" | "male" | "other" | null;
  marketingOptIn: boolean;
  /** A business customer's GSTIN and legal name, for GST (B2B) invoices. */
  gstin?: string | null;
  legalName?: string | null;
  isActive: boolean;
  tags: string[];
  /** The loyalty tier their recent spend reaches; null when tiers are off. */
  tier: { id: string; name: string; earnMultiplier: number } | null;
  /** Points they can spend now (expired points left out). */
  pointsBalance: number;
  createdAt: number;
}

export interface OrderTypeInfo {
  id: string;
  name: string;
  kind: "dine_in" | "takeaway" | "delivery" | "aggregator";
  isActive: boolean;
  /** Dine-in, Takeaway and Zomato: rename and reorder only. */
  isSystem: boolean;
  sortOrder: number;
}

export interface TableInfo {
  priceTier: "non_ac" | "ac";
  id: string;
  name: string;
  area: string | null;
  sortOrder: number;
  isActive: boolean;
  status: "free" | "occupied" | "billed" | "reserved";
  activeOrders: Array<{ id: string; splitLabel: string | null; status: "open" | "billed" }>;
  link?: { orderId: string; status: "open" | "billed"; label: string; tableName: string } | null;
  reservation?: { id: string; customerName: string; partySize: number; startsAt: number; endsAt: number; startsLocal: string } | null;
}

export interface OrderItem {
  id: string;
  clientRef: string | null;
  productId: string;
  variantId: string | null;
  name: string;
  pricePaise: number;
  gstRate: number;
  qty: number;
  status: "pending" | "sent" | "cancelled";
  note: string | null;
  cancelReason: string | null;
  kotId: string | null;
  /** Set on an item inside a combo: the combo's own line. */
  parentItemId?: string | null;
  /** Held back from the kitchen until staff fire it (pending items only; a combo's line holds its items). */
  held?: boolean;
}

export interface Order {
  notes?: string;
  guestCount?: number | null;
  soldById?: string | null;
  soldByName?: string | null;
  summaryRevision?: number;
  captainId?: string | null;
  captainName?: string | null;
  priceTier: PriceTier;
  stockWarnings: import("@masalapos/domain").StockWarning[];
  id: string;
  clientRef: string;
  type: "dine_in" | "parcel" | "zomato";
  /** The order type id: a built-in id (same as `type`) or the restaurant's own takeaway/delivery type. */
  orderTypeId: string;
  /** Name of the restaurant's own type; null for the built-in types. */
  orderTypeName: string | null;
  zomatoOrderId: string | null;
  zomatoStatus: "preparing" | "ready" | "picked_up" | null;
  tableId: string | null;
  splitLabel: string | null;
  tableName: string | null;
  tableLabel?: string | null;
  mergedInto: string | null;
  /** The customer attached for discounts and loyalty points. */
  customer: Customer | null;
  status: "open" | "billed" | "settled" | "cancelled";
  openedBy: string;
  openedAt: number;
  closedAt: number | null;
  items: OrderItem[];
  kots: Kot[];
}

export interface Kot {
  id: string;
  kotNo: number;
  stationId: string;
  orderId: string;
  createdAt: number;
  acceptedAt: number | null;
  doneAt: number | null;
}

export interface KotWithContext {
  id: string;
  kotNo: number;
  stationId: string;
  orderId: string;
  createdAt: number;
  acceptedAt: number | null;
  doneAt: number | null;
  orderType: "dine_in" | "parcel" | "zomato";
  orderTypeName?: string | null;
  zomatoOrderId: string | null;
  tableName: string | null;
  splitLabel: string | null;
  items: Array<{
    id: string;
    name: string;
    qty: number;
    note: string | null;
    status: "pending" | "sent" | "cancelled";
  }>;
}
