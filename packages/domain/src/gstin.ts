/**
 * GSTIN validation with the GSTN check character. Plain functions with no zod, so the billing screen can check a buyer's GSTIN
 * as it is typed. The check character is the published GSTN rule: base-36 digits weighted 1, 2, 1, 2 ..., each product
 * reduced to quotient + remainder of 36, and the check character brings the sum to a multiple of 36.
 */
import { GST_STATES, GSTIN_PATTERN } from "./restaurant-profile.js";

const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Codes a buyer's GSTIN may carry that a restaurant can't be in: Other Territory and Centre Jurisdiction. */
const EXTRA_CODES = new Set(["97", "99"]);

/** The check character for the first 14 characters of a GSTIN, or null if they are not 14 base-36 characters. */
export function gstinCheckChar(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = BASE36.indexOf(first14[i]!);
    if (value < 0) return null;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return BASE36[(36 - (sum % 36)) % 36]!;
}

/** What is wrong with a GSTIN, in words for the person typing it, or null when it is valid. */
export function gstinProblem(input: string): string | null {
  const value = input.trim().toUpperCase();
  if (!value) return "Enter the GSTIN";
  if (value.length !== 15) return "A GSTIN has 15 characters";
  if (!GSTIN_PATTERN.test(value)) return "This doesn't look like a GSTIN. Check each character.";
  const code = value.slice(0, 2);
  if (!(code in GST_STATES) && !EXTRA_CODES.has(code)) return "The first two digits aren't a GST state code";
  if (gstinCheckChar(value.slice(0, 14)) !== value[14]) return "This GSTIN fails the check-character test. Check it for a typing mistake.";
  return null;
}

export const isValidGstin = (input: string) => gstinProblem(input) === null;
