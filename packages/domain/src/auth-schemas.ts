import { z } from "zod";

export const PIN = z.string().regex(/^\d{4,6}$/, "PIN must be 4-6 digits");

export const LoginBody = z.object({ pin: PIN });
export type LoginInput = z.infer<typeof LoginBody>;

export const SetupBody = z.object({
  restaurantName: z.string().trim().min(1),
  adminName: z.string().trim().min(1),
  pin: PIN,
});
export type SetupInput = z.infer<typeof SetupBody>;
