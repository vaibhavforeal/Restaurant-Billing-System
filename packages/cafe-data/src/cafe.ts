import { z } from "zod";
import { uuidv7 } from "@masalapos/domain/id";
import { GST_MODES } from "@masalapos/domain/gst";
import { ROUND_OFF_MODES } from "@masalapos/domain/round-off";
import { RECEIPT_STYLES, type ReceiptStyle } from "@masalapos/domain/receipt-styles";
import { OptionalGstin } from "@masalapos/domain/gstin-schema";
import { UpiId } from "@masalapos/domain/settings-schemas";
import type { SqlDriver } from "./driver.js";
import { dataChanged } from "./events.js";

export interface CafeSettings {
  name: string; address: string; phone: string; gstin: string; fssai: string;
  gstMode: "included" | "exclusive" | "none"; defaultGstRate: 0 | 5 | 12 | 18 | 28; roundOff: "rupee" | "half" | "off";
  invoicePrefix: string; receiptHeader: string; receiptFooter: string; receiptStyle: ReceiptStyle; upiId: string;
}
export interface Device { id: string; name: string; seriesLetter: string }

const text = (max: number) => z.string().trim().max(max);

/** What the owner can set. The bill prefix plus the device letter must fit the four characters an invoice series allows. */
export const CafeSettingsInput: z.ZodType<CafeSettings> = z.object({
  name: z.string().trim().min(1, "Enter the cafe's name").max(60),
  address: text(200),
  phone: text(20),
  gstin: OptionalGstin,
  fssai: z.string().trim().refine((v) => v === "" || /^\d{14}$/.test(v), "Enter the 14-digit FSSAI licence number, or leave it blank"),
  gstMode: z.enum(GST_MODES),
  defaultGstRate: z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28)]),
  roundOff: z.enum(ROUND_OFF_MODES),
  invoicePrefix: z.string().trim().toUpperCase()
    .regex(/^[A-Z0-9]{0,3}$/, "Use up to three letters or digits")
    .refine((v) => v !== "CN", "CN is kept for credit notes"),
  receiptHeader: text(200),
  receiptFooter: text(200),
  receiptStyle: z.enum(RECEIPT_STYLES),
  upiId: UpiId,
});

interface CafeRow {
  name: string; address: string; phone: string; gstin: string; fssai: string; gst_mode: CafeSettings["gstMode"];
  default_gst_rate: CafeSettings["defaultGstRate"]; round_off: CafeSettings["roundOff"]; invoice_prefix: string;
  receipt_header: string; receipt_footer: string; receipt_style: ReceiptStyle; upi_id: string;
}

export function getCafe(db: SqlDriver): CafeSettings | null {
  const r = db.get<CafeRow>("SELECT * FROM cafe WHERE deleted_at IS NULL LIMIT 1");
  if (!r) return null;
  return {
    name: r.name, address: r.address, phone: r.phone, gstin: r.gstin, fssai: r.fssai, gstMode: r.gst_mode,
    defaultGstRate: r.default_gst_rate, roundOff: r.round_off, invoicePrefix: r.invoice_prefix, receiptHeader: r.receipt_header,
    receiptFooter: r.receipt_footer, receiptStyle: r.receipt_style, upiId: r.upi_id,
  };
}

/** Saves the settings. The first save also creates this phone's device row: "Counter 1", series letter "A". */
export function saveCafe(db: SqlDriver, input: unknown, now: number): CafeSettings {
  const c = CafeSettingsInput.parse(input);
  const values = [c.name, c.address, c.phone, c.gstin, c.fssai, c.gstMode, c.defaultGstRate, c.roundOff, c.invoicePrefix,
    c.receiptHeader, c.receiptFooter, c.receiptStyle, c.upiId, now];
  db.transaction(() => {
    const existing = db.get<{ id: string }>("SELECT id FROM cafe WHERE deleted_at IS NULL LIMIT 1");
    if (existing) {
      db.run(`UPDATE cafe SET name = ?, address = ?, phone = ?, gstin = ?, fssai = ?, gst_mode = ?, default_gst_rate = ?, round_off = ?,
        invoice_prefix = ?, receipt_header = ?, receipt_footer = ?, receipt_style = ?, upi_id = ?, updated_at = ? WHERE id = ?`, [...values, existing.id]);
    } else {
      db.run(`INSERT INTO cafe (name, address, phone, gstin, fssai, gst_mode, default_gst_rate, round_off, invoice_prefix,
        receipt_header, receipt_footer, receipt_style, upi_id, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...values, uuidv7()]);
    }
    if (!db.get("SELECT id FROM device")) db.run("INSERT INTO device (id, name, series_letter) VALUES (?, 'Counter 1', 'A')", [uuidv7()]);
  });
  dataChanged();
  return c;
}

export function getDevice(db: SqlDriver): Device | null {
  const r = db.get<{ id: string; name: string; series_letter: string }>("SELECT id, name, series_letter FROM device LIMIT 1");
  return r ? { id: r.id, name: r.name, seriesLetter: r.series_letter } : null;
}
