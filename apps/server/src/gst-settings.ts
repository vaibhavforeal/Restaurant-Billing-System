import type { Database, GstMode, RoundOff } from "@masalapos/domain";

export interface GstSettings {
  gstMode: GstMode;
  gstRate: number;
}

/** The restaurant's GST mode and default item rate. */
export function readGstSettings(db: Database): GstSettings {
  const row = db.prepare("SELECT gst_mode, gst_rate FROM settings WHERE id = 1").get() as { gst_mode: GstMode; gst_rate: number };
  return { gstMode: row.gst_mode, gstRate: row.gst_rate };
}

/** What a new bill is priced and numbered with. */
export function readBillingSettings(db: Database): { gstMode: GstMode; roundOff: RoundOff; invoicePrefix: string } {
  const row = db.prepare("SELECT gst_mode, round_off, invoice_prefix FROM settings WHERE id = 1").get() as { gst_mode: GstMode; round_off: RoundOff; invoice_prefix: string };
  return { gstMode: row.gst_mode, roundOff: row.round_off, invoicePrefix: row.invoice_prefix };
}
