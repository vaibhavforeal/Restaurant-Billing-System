import { z } from "zod";

/** Indian GST slabs — a fixed vocabulary so a typo like 0.05 or 7 cannot land in the DB. */
export const GST_RATES = [0, 5, 12, 18, 28] as const;

const GstRate = z.number().refine((r) => (GST_RATES as readonly number[]).includes(r), "invalid GST rate");
const Paise = z.number().int().min(0);
const Name = z.string().trim().min(1);

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
});
export type VariantCreateInput = z.infer<typeof VariantCreate>;

export const VariantUpdate = z.object({
  name: Name.optional(),
  pricePaise: Paise.optional(),
  isActive: z.boolean().optional(),
});
export type VariantUpdateInput = z.infer<typeof VariantUpdate>;

export const ProductCreate = z.object({
  categoryId: z.string().min(1),
  name: Name,
  pricePaise: Paise,
  gstRate: GstRate,
  isVeg: z.boolean().default(true),
  kotStationId: z.string().min(1).nullable().default(null),
  variants: z.array(VariantCreate).default([]),
});
export type ProductCreateInput = z.infer<typeof ProductCreate>;

export const ProductUpdate = z.object({
  categoryId: z.string().min(1).optional(),
  name: Name.optional(),
  pricePaise: Paise.optional(),
  gstRate: GstRate.optional(),
  isVeg: z.boolean().optional(),
  kotStationId: z.string().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type ProductUpdateInput = z.infer<typeof ProductUpdate>;
