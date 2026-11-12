import type { Bill } from "@masalapos/domain/billing";
import { UpiId } from "@masalapos/domain/settings-schemas";
import QRCode from "qrcode";

/** A UPI payment link for an exact amount, or null when there is no UPI id or nothing to pay. */
export function upiPaymentUri(p: { upiId: string; payeeName: string; amountPaise: number; ref: string; note: string }): string | null {
  const parsed = UpiId.safeParse(p.upiId);
  if (!parsed.success || !parsed.data || !Number.isSafeInteger(p.amountPaise) || p.amountPaise <= 0) return null;
  const params = {
    pa: parsed.data,
    pn: Array.from(p.payeeName.replace(/[\x00-\x1f\x7f]/g, " ").trim()).slice(0, 50).join(""),
    am: (p.amountPaise / 100).toFixed(2),
    cu: "INR",
    tr: p.ref.replace(/[^a-zA-Z0-9]/g, "").slice(0, 35),
    tn: p.note,
  };
  // Percent-encode values (including spaces) for UPI app compatibility.
  return `upi://pay?${Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
}

/** A payment request, never evidence that a payment was received. */
export function billUpiPayment(bill: Bill) {
  if (bill.status !== "unpaid") return null;
  const amountPaise = bill.totalPaise - bill.payments.reduce((sum, p) => sum + p.amountPaise, 0);
  const uri = upiPaymentUri({ upiId: bill.receipt.upiId ?? "", payeeName: bill.receipt.restaurantName, amountPaise, ref: bill.id, note: `Bill ${bill.invoiceNo}` });
  if (!uri) return null;
  return { upiId: UpiId.parse(bill.receipt.upiId), amountPaise, uri };
}

/** Locally generated black/white SVG with the required four-module quiet zone. */
export function upiQrSvg(uri: string): string {
  const { modules } = QRCode.create(uri, { errorCorrectionLevel: "M" });
  const size = modules.size + 8;
  const cells: string[] = [];
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (modules.get(y, x)) cells.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Scan to pay this bill by UPI" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${cells.join("")}" fill="#000"/></svg>`;
}

/** Center within the 203dpi printable area; integer scaling avoids blurred modules. */
export function upiQrRaster(uri: string, paperWidth: 58 | 80) {
  const { modules } = QRCode.create(uri, { errorCorrectionLevel: "M" });
  const width = paperWidth === 58 ? 384 : 576;
  const scale = Math.min(6, Math.floor(288 / (modules.size + 8)));
  const height = (modules.size + 8) * scale;
  const left = Math.floor((width - height) / 2) + 4 * scale;
  const widthBytes = width / 8;
  const data = new Uint8Array(widthBytes * height);
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (!modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + 4) * scale + dy) * widthBytes;
        for (let dx = 0; dx < scale; dx++) {
          const pixel = left + x * scale + dx;
          const index = row + (pixel >> 3);
          data[index] = data[index]! | (0x80 >> (pixel & 7));
        }
      }
    }
  }
  return { widthBytes, height, data };
}
