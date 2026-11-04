import { z } from "zod";
import { RestaurantProfile } from "./restaurant-profile-schema.js";

export const PIN = z.string().regex(/^\d{4,6}$/, "PIN must be 4-6 digits");

export const LoginBody = z.object({ pin: PIN });
export type LoginInput = z.infer<typeof LoginBody>;

/** First-run setup: the restaurant's details and the first admin, written together. */
export const SetupBody = RestaurantProfile.and(z.object({
  adminName: z.string().trim().min(1),
  pin: PIN,
}));
export type SetupInput = z.infer<typeof SetupBody>;
