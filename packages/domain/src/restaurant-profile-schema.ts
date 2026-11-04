import { z } from "zod";
import { GSTIN_STATE_MESSAGE, PROFILE_RULES, gstinMatchesState, normalisePhone, type ProfileField } from "./restaurant-profile.js";

/** A trimmed string checked by the same rule the setup screen uses. */
const ruled = (field: ProfileField) => z.string().trim().superRefine((value, ctx) => {
  const message = PROFILE_RULES[field](value);
  if (message) ctx.addIssue({ code: "custom", message });
});

export const Phone = ruled("phone").transform(normalisePhone);
export const Pincode = ruled("pincode");
export const StateCode = ruled("stateCode");
export const Gstin = ruled("gstin").transform((v) => v.toUpperCase());
export const Fssai = ruled("fssai");

/** The restaurant's details that setup asks for and bills print. */
export const RestaurantProfile = z.object({
  restaurantName: ruled("restaurantName"),
  address: ruled("address"),
  city: ruled("city"),
  stateCode: StateCode,
  pincode: Pincode,
  phone: Phone,
  gstin: Gstin.default(""),
  fssai: Fssai.default(""),
}).superRefine((p, ctx) => {
  if (!gstinMatchesState(p.gstin, p.stateCode)) ctx.addIssue({ code: "custom", path: ["gstin"], message: GSTIN_STATE_MESSAGE });
});
export type RestaurantProfileInput = z.input<typeof RestaurantProfile>;
