import { SettingsUpdate } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";

interface SettingsRow {
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
      .prepare("SELECT restaurant_name, address, gstin, fssai, receipt_footer FROM settings WHERE id = 1")
      .get() as SettingsRow;
    return {
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
      .prepare("UPDATE settings SET restaurant_name = ?, address = ?, gstin = ?, fssai = ?, receipt_footer = ? WHERE id = 1")
      .run(body.restaurantName, body.address, body.gstin, body.fssai, body.receiptFooter);
    return { settings: readSettings() };
  });
}
