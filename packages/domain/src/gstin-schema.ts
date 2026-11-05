import { z } from "zod";
import { gstinProblem } from "./gstin.js";

/** A GSTIN checked for its shape, state code and check character; upper-cased. */
export const ValidGstin = z.string().trim().transform((value, ctx) => {
  const problem = gstinProblem(value);
  if (problem) { ctx.addIssue({ code: "custom", message: problem }); return z.NEVER; }
  return value.toUpperCase();
});
/** A valid GSTIN, or "" for none. */
export const OptionalGstin = z.string().trim().transform((value, ctx) => {
  if (!value) return "";
  const problem = gstinProblem(value);
  if (problem) { ctx.addIssue({ code: "custom", message: problem }); return z.NEVER; }
  return value.toUpperCase();
});
