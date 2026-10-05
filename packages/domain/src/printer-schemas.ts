import { z } from "zod";

const Name = z.string().trim().min(1);

export const PrintProfile = z.object({
  copies: z.number().int().min(1).max(5).default(1),
  feedLines: z.number().int().min(0).max(10).default(3),
  autoCut: z.boolean().default(true),
});
export type PrintProfileInput = z.infer<typeof PrintProfile>;

export function networkPrinterAddress(connection: string): { host: string; port: number } {
  if (/[\s/\\?#@]/.test(connection)) throw new Error("Use a host or IP address with an optional port");
  const match = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._-]+)(?::(\d+))?$/.exec(connection);
  if (!match) throw new Error("Use a host or IP address with an optional port");
  const port = match[2] ? Number(match[2]) : 9100;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Printer port must be 1–65535");
  return { host: match[1]!.replace(/^\[|\]$/g, ""), port };
}

export const PrinterCreate = z.object({
  name: Name,
  kind: z.enum(["network", "windows", "bluetooth"]),
  connection: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/),
  paperWidth: z.union([z.literal(58), z.literal(80)]).default(80),
  receiptProfile: PrintProfile.default(() => PrintProfile.parse({})),
  kotProfile: PrintProfile.default(() => PrintProfile.parse({})),
}).superRefine((value, ctx) => {
  try {
    if (value.kind === "network") networkPrinterAddress(value.connection);
    if (value.kind === "bluetooth" && !/^COM[1-9]\d{0,3}$/i.test(value.connection)) throw new Error("Use a COM port such as COM3");
  } catch (error) { ctx.addIssue({ code: "custom", path: ["connection"], message: error instanceof Error ? error.message : "Invalid connection" }); }
});
export type PrinterCreateInput = z.infer<typeof PrinterCreate>;

export const PrinterUpdate = z.object({
  name: Name.optional(),
  kind: z.enum(["network", "windows", "bluetooth"]).optional(),
  connection: z.string().trim().min(1).optional(),
  paperWidth: z.union([z.literal(58), z.literal(80)]).optional(),
  isActive: z.boolean().optional(),
  receiptProfile: PrintProfile.optional(),
  kotProfile: PrintProfile.optional(),
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
