import { z } from "zod";

const Name = z.string().trim().min(1);
const ClientRef = z.string().min(8).max(64);

export const ZOMATO_ORDER_ID = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9-]+$/);
export type OrderType = "dine_in" | "parcel" | "zomato";

export const TableCreate = z.object({
  captainId: z.never().optional(), // Captains belong to customer orders, never table configuration.
  priceTier: z.enum(["non_ac", "ac"]).default("non_ac"),
  name: Name,
  area: z.string().trim().min(1).nullable().default(null),
  sortOrder: z.number().int().default(0),
});
export type TableCreateInput = z.infer<typeof TableCreate>;

export const TableUpdate = z.object({
  captainId: z.never().optional(),
  priceTier: z.enum(["non_ac", "ac"]).optional(),
  name: Name.optional(),
  area: z.string().trim().min(1).nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type TableUpdateInput = z.infer<typeof TableUpdate>;

export const OrderCreate = z
  .object({
    clientRef: ClientRef,
    captainId: z.string().min(1).nullable().optional(),
    type: z.enum(["dine_in", "parcel", "zomato"]),
    tableId: z.string().min(1).nullable().default(null),
    zomatoOrderId: ZOMATO_ORDER_ID.optional(),
  })
  .superRefine((o, ctx) => {
    if (o.type === "dine_in" && !o.tableId) ctx.addIssue({ code: "custom", message: "dine_in requires tableId" });
    if (o.type === "parcel" && o.tableId) ctx.addIssue({ code: "custom", message: "parcel cannot have a table" });
    if (o.type === "parcel" && o.captainId) ctx.addIssue({ code: "custom", message: "Select captains for dine-in orders" });
    if (o.type === "zomato" && !o.zomatoOrderId) ctx.addIssue({ code: "custom", message: "zomato requires zomatoOrderId", path: ["zomatoOrderId"] });
    if (o.type === "zomato" && o.tableId) ctx.addIssue({ code: "custom", message: "zomato cannot have a table" });
    if (o.type === "zomato" && o.captainId) ctx.addIssue({ code: "custom", message: "Select captains for dine-in orders" });
    if (o.type !== "zomato" && o.zomatoOrderId) ctx.addIssue({ code: "custom", message: "zomatoOrderId is only for zomato orders", path: ["zomatoOrderId"] });
  });
export type OrderCreateInput = z.infer<typeof OrderCreate>;

export const OrderItemsAdd = z.object({
  items: z
    .array(
      z.object({
        clientRef: ClientRef.optional(),
        productId: z.string().min(1),
        variantId: z.string().min(1).nullable().default(null),
        qty: z.number().int().min(1).max(99),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .min(1),
});
export type OrderItemsAddInput = z.infer<typeof OrderItemsAdd>;

export const OrderItemUpdate = z.object({
  qty: z.number().int().min(1).max(99).optional(),
  note: z.string().trim().max(200).nullable().optional(),
});
export type OrderItemUpdateInput = z.infer<typeof OrderItemUpdate>;

export const ItemCancel = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
});
export type ItemCancelInput = z.infer<typeof ItemCancel>;
