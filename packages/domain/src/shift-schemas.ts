import { z } from "zod";

const Ref = z.string().min(8).max(64);
const Paise = z.number().int().min(0).max(1_000_000_000);

export const ShiftOpen = z.object({ clientRef: Ref, openingFloatPaise: Paise });
export const CashMovementCreate = z.object({
  clientRef: Ref,
  kind: z.enum(["pay_in", "pay_out"]),
  amountPaise: Paise.refine((n) => n > 0, "Enter an amount"),
  reason: z.string().trim().min(1, "Enter a reason").max(200),
});
export const ShiftClose = z.object({ clientRef: Ref, countedCashPaise: Paise, note: z.string().trim().max(200).default("") });
export const DayClose = z.object({
  clientRef: Ref,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date"),
  note: z.string().trim().max(200).default(""),
});
