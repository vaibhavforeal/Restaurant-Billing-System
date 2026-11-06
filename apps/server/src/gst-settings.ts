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

/** What a new bill is priced and numbered with, including the service and packaging charges. */
export function readBillingSettings(db: Database): { gstMode: GstMode; gstRate: number; roundOff: RoundOff; invoicePrefix: string; serviceChargeBp: number; packagingChargePaise: number; serviceChargeLabel: string; packagingChargeLabel: string } {
  const row = db.prepare("SELECT gst_mode, gst_rate, round_off, invoice_prefix, service_charge_bp, packaging_charge_paise, service_charge_label, packaging_charge_label FROM settings WHERE id = 1").get() as {
    gst_mode: GstMode; gst_rate: number; round_off: RoundOff; invoice_prefix: string; service_charge_bp: number; packaging_charge_paise: number; service_charge_label: string; packaging_charge_label: string;
  };
  return { gstMode: row.gst_mode, gstRate: row.gst_rate, roundOff: row.round_off, invoicePrefix: row.invoice_prefix, serviceChargeBp: row.service_charge_bp, packagingChargePaise: row.packaging_charge_paise, serviceChargeLabel: row.service_charge_label, packagingChargeLabel: row.packaging_charge_label };
}
