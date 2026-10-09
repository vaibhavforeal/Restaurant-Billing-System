import type { Bill, PrintProfileInput } from "@forkflow/domain";
import { DEFAULT_PROFILE, finishSlip } from "./profile.js";
import { EscPos, CHARS_PER_LINE } from "./escpos.js";
import { contextLine } from "./templates.js";
import { RECEIPT_CSS } from "./receipt-style.js";
import { billUpiPayment, upiQrRaster, upiQrSvg } from "./upi.js";

export const money = (n: number) => (n / 100).toFixed(2);
export const dateTime = (ms: number) => new Date(ms).toLocaleString("en-IN", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
// User text must never be interpreted as printer commands or HTML.
export const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, " ");
export const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const statusLabel = (bill: Bill) => bill.status === "paid" ? "PAID" : bill.status === "void" ? "VOID" : "PAYMENT DUE";
const paidAmount = (bill: Bill) => bill.payments.reduce((sum, p) => sum + p.amountPaise, 0);
const quantity = (bill: Bill) => bill.receipt.items.reduce((sum, item) => sum + item.qty, 0);
const footer = (bill: Bill) => bill.receipt.receiptFooter || "Thank you for visiting. Please come again.";

/** Wrapping text and label/value lines for one slip; user text is cleaned of control bytes first. */
export function slipWriter(pos: EscPos, width: number): { line: (value: string) => void; pair: (label: string, value: string) => void } {
  function line(value: string) {
    for (const part of value.split(/\r?\n/)) {
      let safe = clean(part);
      while (safe.length > width) {
        const space = safe.lastIndexOf(" ", width);
        const end = space > 0 ? space : width;
        pos.line(safe.slice(0, end).trimEnd());
        safe = safe.slice(end).trimStart();
      }
      pos.line(safe);
    }
  }
  function pair(label: string, value: string) {
    const key = clean(label), text = clean(value);
    if (key.length + text.length + 1 > width) { line(key); line(text.padStart(width)); }
    else line(key + " ".repeat(width - key.length - text.length) + text);
  }
  return { line, pair };
}

export function receiptSlip(bill: Bill, paperWidth: 58 | 80, profile: PrintProfileInput = DEFAULT_PROFILE): Buffer {
  const pos = new EscPos().init();
  const width = CHARS_PER_LINE[paperWidth];
  const { line, pair } = slipWriter(pos, width);
  const r = bill.receipt;
  pos.align("center").bold(true).size(1, 2);
  line(r.restaurantName);
  pos.size(1, 1).bold(false);
  if (r.address) line(r.address);
  if (r.gstin) line(`GSTIN: ${r.gstin}`);
  if (r.fssai) line(`FSSAI: ${r.fssai}`);
  pos.hr(width).bold(true);
  line("RESTAURANT BILL");
  pos.bold(false).align("left");
  pair(`Bill #${bill.billNo}`, statusLabel(bill));
  line(dateTime(bill.createdAt));
  line(r.orderType === "parcel" ? "TAKEAWAY / Parcel" : `DINE-IN: ${contextLine(r.orderType, r.tableName, r.splitLabel)}`);
  pos.hr(width).bold(true);
  pair("ITEM / QTY x RATE", "AMOUNT");
  pos.bold(false);
  line("All amounts in Rs.");
  pos.hr(width);
  r.items.forEach((item, index) => {
    pos.bold(true); line(`${index + 1}. ${item.name}`); pos.bold(false);
    pair(`${item.qty} x ${money(item.pricePaise)}`, money(item.pricePaise * item.qty));
  });
  pos.hr(width);
  pair(`Items: ${r.items.length}`, `Qty: ${quantity(bill)}`);
  pair("Subtotal", money(bill.subtotalPaise));
  if (bill.discountPaise) pair("Discount", `-${money(bill.discountPaise)}`);
  line(bill.taxInclusive ? "Prices include GST" : "GST added to menu prices");
  for (const t of bill.taxes) {
    pair(`Taxable @ ${t.gstRate}%`, money(t.taxablePaise));
    pair(`CGST @ ${t.gstRate / 2}%`, money(t.cgstPaise));
    pair(`SGST @ ${t.gstRate / 2}%`, money(t.sgstPaise));
  }
  pair("Round off", money(bill.roundingPaise));
  pos.hr(width).bold(true).size(1, 2);
  pair("TOTAL Rs.", money(bill.totalPaise));
  pos.size(1, 1).bold(false).hr(width);
  if (bill.discountNote) line(`Discount reason: ${bill.discountNote}`);
  if (bill.payments.length) {
    pos.bold(true); line("PAYMENT DETAILS"); pos.bold(false);
    for (const p of bill.payments) pair(p.mode.toUpperCase(), money(p.amountPaise));
  }
  pos.bold(true);
  if (bill.status === "unpaid") pair("AMOUNT DUE Rs.", money(Math.max(0, bill.totalPaise - paidAmount(bill))));
  else line(bill.status === "paid" ? "PAID IN FULL" : "VOID - NOT PAYABLE");
  pos.bold(false).hr(width).align("center");
  const payment = billUpiPayment(bill);
  if (payment) {
    pos.bold(true); line(`SCAN & PAY Rs. ${money(payment.amountPaise)}`); pos.bold(false);
    const qr = upiQrRaster(payment.uri, paperWidth);
    // The bitmap already includes centered padding across the full print width.
    pos.align("left").raster(qr.widthBytes, qr.height, qr.data).align("center");
    line(`UPI: ${payment.upiId}`);
    line(`Bill #${bill.billNo}`);
    pos.hr(width);
  }
  line(footer(bill));
  return finishSlip(pos, profile);
}

/** Script-free, offline A4 HTML; the UI prints a sandboxed same-origin frame. */
export function receiptHtml(bill: Bill): string {
  const r = bill.receipt;
  const e = escape;
  const due = Math.max(0, bill.totalPaise - paidAmount(bill));
  const service = r.orderType === "zomato" ? "Zomato" : r.orderType === "parcel" ? "Takeaway / Parcel" : "Dine-in";
  const order = r.orderType === "zomato" ? `Zomato #${e(r.zomatoOrderId ?? "")}` : "Parcel";
  // Zomato collects and pays the GST on its orders (section 9(5)): the bill shows the note, never per-rate GST lines.
  const zomatoGst = r.gstPaidBy === "zomato";
  const payment = billUpiPayment(bill);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bill #${bill.billNo}</title><style>${RECEIPT_CSS}
  @page{@bottom-left{content:"Bill #${bill.billNo}";font:9px Arial,sans-serif;color:#71717a}}
  </style></head><body><main class="bill" aria-label="Restaurant bill">
  <header class="bill-header"><div><h1>${e(r.restaurantName)}</h1>
    ${r.address ? `<p class="address">${e(r.address)}</p>` : ""}
    <div class="registration">${r.gstin ? `<span>GSTIN: ${e(r.gstin)}</span>` : ""}${r.fssai ? `<span>FSSAI: ${e(r.fssai)}</span>` : ""}</div>
  </div><div class="bill-identity"><p class="eyebrow">Restaurant bill</p><p class="bill-number">Bill #${bill.billNo}</p><span class="status">${statusLabel(bill)}</span></div></header>
  <dl class="bill-meta"><div><dt>Issued on</dt><dd>${e(dateTime(bill.createdAt))}</dd></div><div><dt>Service</dt><dd>${service}</dd></div>
    <div><dt>${r.orderType === "dine_in" ? "Table / Group" : "Order"}</dt><dd>${r.orderType === "dine_in" ? e(contextLine(r.orderType, r.tableName, r.splitLabel)) : order}</dd></div></dl>
  <table class="items" aria-label="Bill items"><thead><tr><th scope="col">#</th><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Rate ₹</th><th scope="col">Amount ₹</th></tr></thead><tbody>
    ${r.items.map((i, index) => `<tr><td>${index + 1}</td><td><span class="item-name">${e(i.name)}</span>${zomatoGst ? "" : `<span class="item-tax">GST ${i.gstRate}%</span>`}</td><td>${i.qty}</td><td class="amount">${money(i.pricePaise)}</td><td class="amount"><strong>${money(i.pricePaise * i.qty)}</strong></td></tr>`).join("")}
  </tbody></table><div class="item-count"><span>${r.items.length} items · ${quantity(bill)} total quantity</span><span>All amounts in INR</span></div>
  <div class="summary">${zomatoGst ? `<section aria-label="GST"><h2 class="section-title">GST</h2><p class="tax-note">GST paid by Zomato (section 9(5))</p></section>` : `<section aria-label="GST breakdown"><h2 class="section-title">GST breakdown (₹)</h2>
    <table class="taxes"><thead><tr><th scope="col">GST</th><th scope="col">Taxable</th><th scope="col">CGST</th><th scope="col">SGST</th></tr></thead><tbody>
    ${bill.taxes.map((t) => `<tr><td>${t.gstRate}%</td><td>${money(t.taxablePaise)}</td><td>${money(t.cgstPaise)}<br><small>@ ${t.gstRate / 2}%</small></td><td>${money(t.sgstPaise)}<br><small>@ ${t.gstRate / 2}%</small></td></tr>`).join("")}
    </tbody></table><p class="tax-note">${bill.taxInclusive ? "Prices include GST" : "GST added to menu prices"}</p>
  </section>`}<section aria-label="Bill totals"><table class="totals"><tbody>
    <tr><td>Subtotal</td><td class="amount">₹${money(bill.subtotalPaise)}</td></tr>
    ${bill.discountPaise ? `<tr><td>Discount</td><td class="amount">-₹${money(bill.discountPaise)}</td></tr>` : ""}
    ${zomatoGst ? "" : `<tr><td>CGST${bill.taxInclusive ? " (included)" : ""}</td><td class="amount">₹${money(bill.cgstPaise)}</td></tr>
    <tr><td>SGST${bill.taxInclusive ? " (included)" : ""}</td><td class="amount">₹${money(bill.sgstPaise)}</td></tr>`}
    <tr><td>Round off</td><td class="amount">₹${money(bill.roundingPaise)}</td></tr>
    <tr class="grand-total"><td>Grand total</td><td class="amount">₹${money(bill.totalPaise)}</td></tr>
  </tbody></table>${bill.discountNote ? `<p class="discount-note">Discount reason: ${e(bill.discountNote)}</p>` : ""}</section></div>
  <section class="payments" aria-label="Payment details"><div><h2 class="section-title">Payment details</h2>
    ${bill.payments.length ? `<div class="payment-methods">${bill.payments.map((p) => `<span><b>${e(p.mode.toUpperCase())}</b> ₹${money(p.amountPaise)}</span>`).join("")}</div>` : `<p class="tax-note">${bill.status === "paid" ? "No payment required." : bill.status === "void" ? "This bill is void." : "Payment not yet received."}</p>`}
  </div><div class="payment-state"><strong>${bill.status === "paid" ? "PAID IN FULL" : bill.status === "void" ? "VOID - NOT PAYABLE" : `AMOUNT DUE ₹${money(due)}`}</strong>
    ${bill.payments.length ? `<span>Received ₹${money(paidAmount(bill))}</span>` : ""}</div></section>
  ${payment ? `<section class="upi-payment" aria-label="UPI payment"><div class="upi-qr">${upiQrSvg(payment.uri)}</div><div><h2 class="section-title">Scan &amp; pay with UPI</h2><p class="upi-amount">₹${money(payment.amountPaise)}</p><p>${e(r.restaurantName)}</p><p class="upi-id">${e(payment.upiId)}</p><p class="tax-note">Bill #${bill.billNo} · Amount filled in automatically</p></div></section>` : ""}
  <footer>${e(footer(bill))}</footer></main></body></html>`;
}
