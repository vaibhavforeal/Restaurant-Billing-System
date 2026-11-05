import { GSTIN_STATE_MESSAGE, SettingsUpdate, gstinMatchesState, type Database, type GstMode, type ReceiptStyle } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { sampleBill } from "./print/bill-preview.js";
import { receiptHtml } from "./print/receipt.js";

interface SettingsRow {
  gst_mode: GstMode;
  gst_rate: number;
  receipt_style: ReceiptStyle;
  upi_id: string;
  restaurant_name: string;
  address: string;
  city: string;
  state_code: string;
  pincode: string;
  phone: string;
  gstin: string;
  fssai: string;
  receipt_footer: string;
  receipt_header: string;
  bill_show_fssai: number;
  bill_show_customer: number;
  bill_show_table: number;
  bill_show_served_by: number;
  bill_show_item_gst: number;
  kot_edit_print: "ask" | "always" | "never";
  hold_orders_enabled: number;
  popular_items_enabled: number;
  popular_by_time_enabled: number;
  ordered_together_enabled: number;
  customer_usual_enabled: number;
  sac_code: string;
  zomato_gstin: string;
}

export function readSettings(db: Database) {
  const r = db
    .prepare("SELECT restaurant_name, address, city, state_code, pincode, phone, gstin, fssai, receipt_footer, receipt_header, bill_show_fssai, bill_show_customer, bill_show_table, bill_show_served_by, bill_show_item_gst, upi_id, receipt_style, gst_mode, gst_rate, kot_edit_print, hold_orders_enabled, popular_items_enabled, popular_by_time_enabled, ordered_together_enabled, customer_usual_enabled, sac_code, zomato_gstin FROM settings WHERE id = 1")
    .get() as SettingsRow;
  return {
    gstMode: r.gst_mode,
    gstRate: r.gst_rate,
    receiptStyle: r.receipt_style,
    upiId: r.upi_id,
    restaurantName: r.restaurant_name,
    address: r.address,
    city: r.city,
    stateCode: r.state_code,
    pincode: r.pincode,
    phone: r.phone,
    gstin: r.gstin,
    fssai: r.fssai,
    receiptFooter: r.receipt_footer,
    receiptHeader: r.receipt_header,
    billShowFssai: r.bill_show_fssai === 1,
    billShowCustomer: r.bill_show_customer === 1,
    billShowTable: r.bill_show_table === 1,
    billShowServedBy: r.bill_show_served_by === 1,
    billShowItemGst: r.bill_show_item_gst === 1,
    kotEditPrint: r.kot_edit_print,
    holdOrdersEnabled: r.hold_orders_enabled === 1,
    popularItemsEnabled: r.popular_items_enabled === 1,
    popularByTimeEnabled: r.popular_by_time_enabled === 1,
    orderedTogetherEnabled: r.ordered_together_enabled === 1,
    customerUsualEnabled: r.customer_usual_enabled === 1,
    sacCode: r.sac_code,
    zomatoGstin: r.zomato_gstin,
  };
}

export function registerSettings(app: FastifyInstance): void {
  const manage = app.requirePermission("settings.manage");

  app.get("/api/settings", { preHandler: manage }, async () => ({ settings: readSettings(app.db) }));

  // Renders a fixed sample bill from the unsaved form; nothing is saved.
  app.post("/api/settings/bill-preview", { preHandler: manage }, async (req) => {
    const body = SettingsUpdate.parse(req.body);
    const saved = readSettings(app.db);
    const show = (v: boolean | undefined, fallback: boolean) => v ?? fallback;
    return { html: receiptHtml(sampleBill({ ...body, city: body.city ?? saved.city, stateCode: body.stateCode ?? saved.stateCode, pincode: body.pincode ?? saved.pincode, phone: body.phone ?? saved.phone,
      billShowFssai: show(body.billShowFssai, saved.billShowFssai), billShowCustomer: show(body.billShowCustomer, saved.billShowCustomer), billShowTable: show(body.billShowTable, saved.billShowTable),
      billShowServedBy: show(body.billShowServedBy, saved.billShowServedBy), billShowItemGst: show(body.billShowItemGst, saved.billShowItemGst),
      gstMode: body.gstMode ?? saved.gstMode, upiId: body.upiId ?? saved.upiId, receiptStyle: body.receiptStyle ?? saved.receiptStyle })) };
  });

  app.put("/api/settings", { preHandler: manage }, async (req, reply) => {
    const body = SettingsUpdate.parse(req.body);
    // A GSTIN saved without the state is checked against the state already on file.
    const stateCode = body.stateCode ?? readSettings(app.db).stateCode;
    if (stateCode && !gstinMatchesState(body.gstin, stateCode)) return reply.status(400).send({ error: GSTIN_STATE_MESSAGE });
    if (stateCode && body.zomatoGstin && !gstinMatchesState(body.zomatoGstin, stateCode)) return reply.status(400).send({ error: "Use Zomato's GSTIN for your state" });
    app.db
      .prepare("UPDATE settings SET restaurant_name = ?, address = ?, city = COALESCE(?, city), state_code = COALESCE(?, state_code), pincode = COALESCE(?, pincode), phone = COALESCE(?, phone), gstin = ?, fssai = ?, receipt_footer = ?, receipt_header = ?, bill_show_fssai = COALESCE(?, bill_show_fssai), bill_show_customer = COALESCE(?, bill_show_customer), bill_show_table = COALESCE(?, bill_show_table), bill_show_served_by = COALESCE(?, bill_show_served_by), bill_show_item_gst = COALESCE(?, bill_show_item_gst), upi_id = COALESCE(?, upi_id), receipt_style = COALESCE(?, receipt_style), gst_mode = COALESCE(?, gst_mode), gst_rate = COALESCE(?, gst_rate), kot_edit_print = COALESCE(?, kot_edit_print), hold_orders_enabled = COALESCE(?, hold_orders_enabled), popular_items_enabled = COALESCE(?, popular_items_enabled), popular_by_time_enabled = COALESCE(?, popular_by_time_enabled), ordered_together_enabled = COALESCE(?, ordered_together_enabled), customer_usual_enabled = COALESCE(?, customer_usual_enabled), sac_code = COALESCE(?, sac_code), zomato_gstin = COALESCE(?, zomato_gstin) WHERE id = 1")
      .run(body.restaurantName, body.address, body.city ?? null, body.stateCode ?? null, body.pincode ?? null, body.phone ?? null, body.gstin, body.fssai, body.receiptFooter, body.receiptHeader,
        ...[body.billShowFssai, body.billShowCustomer, body.billShowTable, body.billShowServedBy, body.billShowItemGst].map((v) => (v === undefined ? null : v ? 1 : 0)),
        body.upiId ?? null, body.receiptStyle ?? null, body.gstMode ?? null, body.gstRate ?? null, body.kotEditPrint ?? null,
        body.holdOrdersEnabled === undefined ? null : body.holdOrdersEnabled ? 1 : 0,
        body.popularItemsEnabled === undefined ? null : body.popularItemsEnabled ? 1 : 0,
        body.popularByTimeEnabled === undefined ? null : body.popularByTimeEnabled ? 1 : 0,
        body.orderedTogetherEnabled === undefined ? null : body.orderedTogetherEnabled ? 1 : 0,
        body.customerUsualEnabled === undefined ? null : body.customerUsualEnabled ? 1 : 0,
        body.sacCode ?? null, body.zomatoGstin ?? null);
    // Order screens and captain tablets show or hide Hold, the Popular badges and the ordered-together suggestions from these settings.
    app.broadcast("settings.changed", {});
    return { settings: readSettings(app.db) };
  });
}
