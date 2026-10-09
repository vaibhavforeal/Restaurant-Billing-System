import { SettingsUpdate, type GstMode, type ReceiptStyle } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";

interface SettingsRow {
  gst_mode: GstMode;
  gst_rate: number;
  receipt_style: ReceiptStyle;
  upi_id: string;
  restaurant_name: string;
  address: string;
  gstin: string;
  fssai: string;
  receipt_footer: string;
}

export function registerSettings(app: FastifyInstance): void {
  const manage = app.requirePermission("settings.manage");

  const readSettings = () => {
    const r = app.db
      .prepare("SELECT restaurant_name, address, gstin, fssai, receipt_footer, upi_id, receipt_style, gst_mode, gst_rate FROM settings WHERE id = 1")
      .get() as SettingsRow;
    return {
      gstMode: r.gst_mode,
      gstRate: r.gst_rate,
      receiptStyle: r.receipt_style,
      upiId: r.upi_id,
      restaurantName: r.restaurant_name,
      address: r.address,
      gstin: r.gstin,
      fssai: r.fssai,
      receiptFooter: r.receipt_footer,
    };
  };

  app.get("/api/settings", { preHandler: manage }, async () => ({ settings: readSettings() }));

  app.put("/api/settings", { preHandler: manage }, async (req) => {
    const body = SettingsUpdate.parse(req.body);
    app.db
      .prepare("UPDATE settings SET restaurant_name = ?, address = ?, gstin = ?, fssai = ?, receipt_footer = ?, upi_id = COALESCE(?, upi_id), receipt_style = COALESCE(?, receipt_style), gst_mode = COALESCE(?, gst_mode), gst_rate = COALESCE(?, gst_rate) WHERE id = 1")
      .run(body.restaurantName, body.address, body.gstin, body.fssai, body.receiptFooter, body.upiId ?? null, body.receiptStyle ?? null, body.gstMode ?? null, body.gstRate ?? null);
    return { settings: readSettings() };
  });
}
