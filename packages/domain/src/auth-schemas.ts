import { z } from "zod";
import { RestaurantProfile } from "./restaurant-profile-schema.js";

/** An admin's approval PIN: typed at the counter to approve discounts, voids, refunds and remote support. Not used to sign in. */
export const PIN = z.string().regex(/^\d{4,6}$/, "PIN must be 4-6 digits");

/** Sign-in names are lower case, so "Meera" and "meera" are the same person. */
export const Username = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, "Use 3-32 letters, numbers, dots, dashes or underscores for the username, starting with a letter or number");
export const Password = z.string()
  .min(8, "Use at least 8 characters for the password")
  .max(128, "Keep the password under 128 characters")
  .refine((v) => v.trim().length > 0, "The password cannot be only spaces");

export const LoginBody = z.object({ username: z.string().trim().toLowerCase().min(1).max(64), password: z.string().min(1).max(128) });
export type LoginInput = z.infer<typeof LoginBody>;

/** First-run setup: the restaurant's details and the first admin, written together. */
export const SetupBody = RestaurantProfile.and(z.object({
  adminName: z.string().trim().min(1),
  username: Username,
  password: Password,
  pin: PIN,
}));
export type SetupInput = z.infer<typeof SetupBody>;
