import type { Database, GstMode } from "@forkflow/domain";

export interface GstSettings {
  gstMode: GstMode;
  gstRate: number;
}

/** The restaurant's GST mode and default item rate. */
export function readGstSettings(db: Database): GstSettings {
  const row = db.prepare("SELECT gst_mode, gst_rate FROM settings WHERE id = 1").get() as { gst_mode: GstMode; gst_rate: number };
  return { gstMode: row.gst_mode, gstRate: row.gst_rate };
}
