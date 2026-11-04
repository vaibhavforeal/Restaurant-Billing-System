import { z } from "zod";
import { Password, PIN, Username } from "./auth-schemas.js";

export const RoleEnum = z.enum(["admin", "cashier", "waiter", "kitchen"]);

export const ADMIN_PIN_MESSAGE = "An admin needs an approval PIN";

/** Everyone signs in with a username and password; admins also have a PIN for approving at the counter. */
export const UserCreate = z.object({
  name: z.string().trim().min(1),
  username: Username,
  password: Password,
  role: RoleEnum,
  pin: PIN.optional(),
}).superRefine((u, ctx) => {
  if (u.role === "admin" && !u.pin) ctx.addIssue({ code: "custom", path: ["pin"], message: ADMIN_PIN_MESSAGE });
});
export type UserCreateInput = z.infer<typeof UserCreate>;

export const UserUpdate = z.object({
  name: z.string().trim().min(1).optional(),
  username: Username.optional(),
  /** A new password set by an admin; it signs the person out everywhere. */
  password: Password.optional(),
  /** A new approval PIN; only admins have one. */
  pin: PIN.optional(),
  role: RoleEnum.optional(),
  isActive: z.boolean().optional(),
  // Overrides the role's discount limit for this person; null goes back to the role's limit.
  maxDiscountPercent: z.number().min(0).max(100).nullable().optional(),
});
export type UserUpdateInput = z.infer<typeof UserUpdate>;
