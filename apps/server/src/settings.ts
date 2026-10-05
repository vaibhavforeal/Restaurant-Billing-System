import { SettingsUpdate } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";

interface SettingsRow {
  upi_id: string;
  tax_inclusive: number;
  require_kitchen_acceptance: number;
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
      .prepare("SELECT restaurant_name, address, gstin, fssai, receipt_footer, tax_inclusive, require_kitchen_acceptance, upi_id FROM settings WHERE id = 1")
      .get() as SettingsRow;
    return {
      upiId: r.upi_id,
      taxInclusive: r.tax_inclusive === 1,
      requireKitchenAcceptance: r.require_kitchen_acceptance === 1,
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
      .prepare("UPDATE settings SET restaurant_name = ?, address = ?, gstin = ?, fssai = ?, receipt_footer = ?, tax_inclusive = COALESCE(?, tax_inclusive), require_kitchen_acceptance = COALESCE(?, require_kitchen_acceptance), upi_id = COALESCE(?, upi_id) WHERE id = 1")
      .run(body.restaurantName, body.address, body.gstin, body.fssai, body.receiptFooter, body.taxInclusive === undefined ? null : Number(body.taxInclusive), body.requireKitchenAcceptance === undefined ? null : Number(body.requireKitchenAcceptance), body.upiId ?? null);
    return { settings: readSettings() };
  });
}
