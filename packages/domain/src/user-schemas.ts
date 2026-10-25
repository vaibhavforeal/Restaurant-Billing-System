import { z } from "zod";
import { PIN } from "./auth-schemas.js";

export const RoleEnum = z.enum(["admin", "cashier", "waiter", "kitchen"]);

export const UserCreate = z.object({
  name: z.string().trim().min(1),
  pin: PIN,
  role: RoleEnum,
});
export type UserCreateInput = z.infer<typeof UserCreate>;

export const UserUpdate = z.object({
  name: z.string().trim().min(1).optional(),
  pin: PIN.optional(),
  role: RoleEnum.optional(),
  isActive: z.boolean().optional(),
  // Overrides the role's discount limit for this person; null goes back to the role's limit.
  maxDiscountPercent: z.number().min(0).max(100).nullable().optional(),
});
export type UserUpdateInput = z.infer<typeof UserUpdate>;
