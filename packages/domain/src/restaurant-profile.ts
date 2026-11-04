/**
 * The restaurant's details that first-run setup asks for and bills print. Plain rules with no zod, so the setup screen can
 * check fields as they are typed without pulling the schema library into the UI; `restaurant-profile-schema.ts` wraps them for the server.
 */

/** GST state and union-territory codes (the first two digits of a GSTIN). */
export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
  "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
  "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra",
  "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};

/** A GSTIN's shape: state code, PAN, entity number, Z, check character. The check character itself is not verified. */
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The state a well-formed GSTIN is registered in, or null. */
export function stateFromGstin(gstin: string): string | null {
  const value = gstin.trim().toUpperCase();
  if (!GSTIN_PATTERN.test(value)) return null;
  const code = value.slice(0, 2);
  return code in GST_STATES ? code : null;
}

/** "+91 98450-12345", "098450 12345" and "(080) 4123 4567" become the ten digits a person dials after 0 or +91. */
export function normalisePhone(input: string): string {
  let digits = input.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

/** A GSTIN must be from the state the restaurant is in. */
export const gstinMatchesState = (gstin: string, stateCode: string) => gstin === "" || gstin.slice(0, 2) === stateCode;
export const GSTIN_STATE_MESSAGE = "This GSTIN is registered in a different state. Check the GSTIN or the state.";

const text = (label: string, max: number) => (v: string) => !v.trim() ? `Enter the ${label}` : v.trim().length > max ? `Keep the ${label} under ${max} characters` : null;

/** Each field's rule: the message to show, or null when the value is fine. */
export const PROFILE_RULES = {
  restaurantName: text("restaurant name", 120),
  address: text("street address", 300),
  city: text("city", 80),
  stateCode: (v: string) => v in GST_STATES ? null : "Choose the state",
  pincode: (v: string) => /^[1-9]\d{5}$/.test(v.trim()) ? null : "Enter the 6-digit PIN code",
  phone: (v: string) => /^[1-9]\d{9}$/.test(normalisePhone(v)) ? null : "Enter a 10-digit mobile number, or a landline with its STD code",
  gstin: (v: string) => { const g = v.trim().toUpperCase(); return g === "" || GSTIN_PATTERN.test(g) ? null : "Enter the 15-character GSTIN, or leave it blank"; },
  fssai: (v: string) => { const f = v.trim(); return f === "" || /^\d{14}$/.test(f) ? null : "Enter the 14-digit FSSAI licence number, or leave it blank"; },
} satisfies Record<string, (value: string) => string | null>;

export type ProfileField = keyof typeof PROFILE_RULES;
export type RestaurantProfileDraft = Record<ProfileField, string>;

/** The first problem with each field, including a GSTIN from another state; empty when the details can be saved. */
export function profileErrors(draft: RestaurantProfileDraft): Partial<Record<ProfileField, string>> {
  const errors: Partial<Record<ProfileField, string>> = {};
  for (const field of Object.keys(PROFILE_RULES) as ProfileField[]) {
    const message = PROFILE_RULES[field](draft[field] ?? "");
    if (message) errors[field] = message;
  }
  if (!errors.gstin && !errors.stateCode && !gstinMatchesState(draft.gstin.trim().toUpperCase(), draft.stateCode)) errors.gstin = GSTIN_STATE_MESSAGE;
  return errors;
}

/** "12 MG Road, Bengaluru, Karnataka - 560001": the address line on bills, without the parts that are empty. */
export function formatRestaurantAddress(p: { address: string; city: string; stateCode: string; pincode: string }): string {
  const place = [p.address.trim(), p.city.trim(), GST_STATES[p.stateCode] ?? ""].filter(Boolean).join(", ");
  const pin = p.pincode.trim();
  return pin ? (place ? `${place} - ${pin}` : pin) : place;
}
