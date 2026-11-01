import { z } from "zod";
import { ComboDefinition } from "./combos.js";

/** Indian GST slabs — a fixed vocabulary so a typo like 0.05 or 7 cannot land in the DB. */
export const GST_RATES = [0, 5, 12, 18, 28] as const;

const GstRate = z.number().refine((r) => (GST_RATES as readonly number[]).includes(r), "invalid GST rate");
const Paise = z.number().int().min(0);
const Name = z.string().trim().min(1);
const Photo = z.string().max(550_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/, "Choose a JPEG photo").nullable();

export const CategoryCreate = z.object({
  name: Name,
  sortOrder: z.number().int().default(0),
});
export type CategoryCreateInput = z.infer<typeof CategoryCreate>;

export const CategoryUpdate = z.object({
  name: Name.optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type CategoryUpdateInput = z.infer<typeof CategoryUpdate>;

export const VariantCreate = z.object({
  name: Name,
  pricePaise: Paise,
  acPricePaise: Paise.nullable().optional(),
  takeawayPricePaise: Paise.nullable().optional(),
  zomatoPricePaise: Paise.nullable().optional(),
});
export type VariantCreateInput = z.infer<typeof VariantCreate>;

export const VariantUpdate = z.object({
  name: Name.optional(),
  pricePaise: Paise.optional(),
  acPricePaise: Paise.nullable().optional(),
  takeawayPricePaise: Paise.nullable().optional(),
  zomatoPricePaise: Paise.nullable().optional(),
  isActive: z.boolean().optional(),
});
export type VariantUpdateInput = z.infer<typeof VariantUpdate>;

export const ProductCreate = z.object({
  categoryId: z.string().min(1),
  name: Name,
  pricePaise: Paise,
  acPricePaise: Paise.nullable().optional(),
  takeawayPricePaise: Paise.nullable().optional(),
  zomatoPricePaise: Paise.nullable().optional(),
  /** null follows the restaurant default rate. */
  gstRate: GstRate.nullable().default(null),
  isVeg: z.boolean().default(true),
  kotStationId: z.string().min(1).nullable().default(null),
  variants: z.array(VariantCreate).default([]),
  description: z.string().trim().max(500).default(""),
  isSoldOut: z.boolean().default(false),
  photo: Photo.optional(),
  /** A combo is sold as one line and holds the items in its slots; it has no variants or kitchen station of its own. */
  kind: z.enum(["item", "combo"]).default("item"),
  combo: ComboDefinition.optional(),
}).superRefine((p, ctx) => {
  if (p.kind === "combo" && !p.combo) ctx.addIssue({ code: "custom", path: ["combo"], message: "Add at least one slot to the combo" });
  if (p.kind === "combo" && p.variants.length) ctx.addIssue({ code: "custom", path: ["variants"], message: "A combo has no variants" });
  if (p.kind === "combo" && p.kotStationId) ctx.addIssue({ code: "custom", path: ["kotStationId"], message: "A combo's items go to their own kitchen stations" });
  if (p.kind === "item" && p.combo) ctx.addIssue({ code: "custom", path: ["combo"], message: "Only a combo has slots" });
});
export type ProductCreateInput = z.infer<typeof ProductCreate>;

export const ProductUpdate = z.object({
  categoryId: z.string().min(1).optional(),
  name: Name.optional(),
  pricePaise: Paise.optional(),
  acPricePaise: Paise.nullable().optional(),
  takeawayPricePaise: Paise.nullable().optional(),
  zomatoPricePaise: Paise.nullable().optional(),
  gstRate: GstRate.nullable().optional(),
  isVeg: z.boolean().optional(),
  kotStationId: z.string().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
  description: z.string().trim().max(500).optional(),
  isSoldOut: z.boolean().optional(),
  photo: Photo.optional(),
  /** Replaces a combo's slots. */
  combo: ComboDefinition.optional(),
});
export type ProductUpdateInput = z.infer<typeof ProductUpdate>;
