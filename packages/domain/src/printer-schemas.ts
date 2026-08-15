import { z } from "zod";

const Name = z.string().trim().min(1);

export const PrinterCreate = z.object({
  name: Name,
  kind: z.enum(["network", "windows", "bluetooth"]),
  connection: z.string().trim().min(1),
  paperWidth: z.union([z.literal(58), z.literal(80)]).default(80),
});
export type PrinterCreateInput = z.infer<typeof PrinterCreate>;

export const PrinterUpdate = z.object({
  name: Name.optional(),
  kind: z.enum(["network", "windows", "bluetooth"]).optional(),
  connection: z.string().trim().min(1).optional(),
  paperWidth: z.union([z.literal(58), z.literal(80)]).optional(),
  isActive: z.boolean().optional(),
});
export type PrinterUpdateInput = z.infer<typeof PrinterUpdate>;

export const StationCreate = z.object({
  name: Name,
  printerId: z.string().min(1).nullable().default(null),
});
export type StationCreateInput = z.infer<typeof StationCreate>;

export const StationUpdate = z.object({
  name: Name.optional(),
  printerId: z.string().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type StationUpdateInput = z.infer<typeof StationUpdate>;
