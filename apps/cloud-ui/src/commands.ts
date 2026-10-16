import { parseRupees } from "./api";
import type { MirrorRecord } from "./api";
export const rowText = (row: Record<string, unknown>, key: string, fallback = "") => String(row[key] ?? fallback);
export const rowBool = (row: Record<string, unknown>, key: string) => row[key] === 1 || row[key] === true;
export interface CommandInput { kind: string; targetId: string; expectedRevision: number; payload: Record<string, unknown> }
export interface CatalogForm { name: string; price: string; active: boolean; description: string; veg: boolean; soldOut: boolean }
export function catalogCommand(table: string, record: MirrorRecord, form: CatalogForm): CommandInput {
  const payload: Record<string, unknown> = { name: form.name.trim(), isActive: form.active };
  if (!payload.name) throw new Error("Enter a name.");
  if (table !== "categories") payload.pricePaise = parseRupees(form.price);
  if (table === "products") Object.assign(payload, { description: form.description.trim(), isVeg: form.veg, isSoldOut: form.soldOut });
  return { kind: table === "categories" ? "category.update" : table === "variants" ? "variant.update" : "product.update", targetId: String(record.key.id), expectedRevision: record.revision, payload };
}
export function settingsCommand(record: MirrorRecord, form: Record<string, string>): CommandInput {
  const payload: Record<string, unknown> = { ...form };
  for (const [name, column] of [["receiptStyle", "receipt_style"], ["gstMode", "gst_mode"], ["gstRate", "gst_rate"]] as const) if (record.row[column] !== undefined) payload[name] = record.row[column];
  return { kind: "settings.update", targetId: "1", expectedRevision: record.revision, payload };
}
export function policyValues(record: MirrorRecord | undefined, key: string): Record<string, boolean> {
  try { const value: unknown = JSON.parse(String(record?.row[key] ?? "{}")); return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "boolean")) : {}; } catch { return {}; }
}
