import type { FastifyInstance } from "fastify";
import type { DeviceRecord } from "../devices.js";
import { httpError } from "../http-error.js";

export interface ReceiptPrinterRow {
  id: string; name: string; kind: "network" | "windows" | "bluetooth"; connection: string; paper_width: 58 | 80; receipt_profile: string;
}

/**
 * The printer for one bill, reprint or credit note.
 *
 * - `override` left out: the calling device's bill printer, or null when it has none or that printer is switched off.
 * - `null`: no printer, whatever the device has.
 * - a printer id: that printer for this request only. It must be active, since the cashier just picked it.
 */
export function receiptPrinter(app: FastifyInstance, device: DeviceRecord | null, override: string | null | undefined): ReceiptPrinterRow | null {
  const id = override === undefined ? app.devices.billPrinterId(device) : override;
  if (id === null) return null;
  const row = app.db.prepare("SELECT * FROM printers WHERE id = ? AND is_active = 1").get(id) as ReceiptPrinterRow | undefined;
  if (!row) throw httpError(400, "Choose an active receipt printer");
  return row;
}
