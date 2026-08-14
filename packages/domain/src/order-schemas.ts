import { z } from "zod";

const Name = z.string().trim().min(1);
const ClientRef = z.string().min(8).max(64);

export const TableCreate = z.object({
  name: Name,
  area: z.string().trim().min(1).nullable().default(null),
  sortOrder: z.number().int().default(0),
});
export type TableCreateInput = z.infer<typeof TableCreate>;

export const TableUpdate = z.object({
  name: Name.optional(),
  area: z.string().trim().min(1).nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type TableUpdateInput = z.infer<typeof TableUpdate>;

export const OrderCreate = z
  .object({
    clientRef: ClientRef,
    type: z.enum(["dine_in", "parcel"]),
    tableId: z.string().min(1).nullable().default(null),
  })
  .superRefine((o, ctx) => {
    if (o.type === "dine_in" && !o.tableId) ctx.addIssue({ code: "custom", message: "dine_in requires tableId" });
    if (o.type === "parcel" && o.tableId) ctx.addIssue({ code: "custom", message: "parcel cannot have a table" });
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
