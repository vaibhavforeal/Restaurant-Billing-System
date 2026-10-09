import { resolveReceiptStyle, type Bill, type PrintProfileInput } from "@forkflow/domain";
import { DEFAULT_PROFILE, finishSlip } from "./profile.js";
import { EscPos, CHARS_PER_LINE } from "./escpos.js";
import { contextLine } from "./templates.js";
import { RESTAURANT_RECEIPT_CSS } from "./restaurant-receipt-style.js";
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
const paymentModes = (bill: Bill) => [...new Set(bill.payments.map((p) => p.mode.toUpperCase()))].join(" + ");
const inclusiveTaxNote = "All prices include tax";
// The declaration a composition-scheme bill of supply must carry.
const compositionNote = "Composition taxable person, not eligible to collect tax on supplies";

function wrapText(value: string, width: number): string[] {
  return value.split(/\r?\n/).flatMap((part) => {
    let safe = clean(part);
    const lines: string[] = [];
    while (safe.length > width) {
      const space = safe.lastIndexOf(" ", width);
      const end = space > 0 ? space : width;
      lines.push(safe.slice(0, end).trimEnd());
      safe = safe.slice(end).trimStart();
    }
    return [...lines, safe];
  });
}

/** Wrapping text and label/value lines for one slip; user text is cleaned of control bytes first. */
export function slipWriter(pos: EscPos, width: number): { line: (value: string) => void; pair: (label: string, value: string) => void } {
  function line(value: string) {
    for (const part of wrapText(value, width)) pos.line(part);
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
  const style = resolveReceiptStyle(r.receiptStyle);
  const zomatoGst = r.gstPaidBy === "zomato";
  const supply = r.gstScheme === "composition";
  const rule = () => pos.line((style === "classic" ? "." : style === "heritage" ? "=" : "-").repeat(width));
  // Fixed numeric columns keep regular rows compact. Oversize values fall back
  // to label/value lines so a large quantity or amount is never truncated.
  const numericWidths = paperWidth === 80 ? [4, 8, 10] : [4, 10];
  const nameWidth = width - numericWidths.reduce((sum, n) => sum + n + 1, 0);
  const row = (name: string, values: string[]) => {
    wrapText(name, nameWidth).forEach((part, index) => line(part.padEnd(nameWidth) +
      (index === 0 ? values.map((value, i) => " " + value.padStart(numericWidths[i]!)).join("") : "")));
  };
  pos.align(style === "modern" || style === "compact" ? "left" : "center").bold(true).size(1, style === "compact" ? 1 : 2);
  line(r.restaurantName);
  pos.size(1, 1).bold(false);
  if (r.address) line(r.address);
  if (r.gstin) line(`GSTIN: ${r.gstin}`);
  if (r.fssai) line(`FSSAI: ${r.fssai}`);
  if (style !== "compact") pos.line();
  pos.bold(true);
  line(supply ? "BILL OF SUPPLY" : "RESTAURANT BILL");
  if (supply) { pos.bold(false); line(compositionNote); }
  if (style !== "compact") pos.line();
  pos.bold(false).align("left");
  line(`Date: ${dateTime(bill.createdAt)}`);
  pair(`Bill #${bill.billNo}`, statusLabel(bill));
  line(r.orderType === "zomato" ? contextLine(r.orderType, null, null, r.zomatoOrderId) :
    r.orderType === "parcel" ? "TAKEAWAY / Parcel" : `DINE-IN: ${contextLine(r.orderType, r.tableName, r.splitLabel)}`);
  if (bill.payments.length) line(`Payment mode: ${paymentModes(bill)}`);
  line("All amounts in Rs.");
  rule().bold(true);
  row("Item", paperWidth === 80 ? ["Qty", "Rate", "Amount"] : ["Qty", "Amount"]);
  pos.bold(false); rule();
  r.items.forEach((item) => {
    const values = paperWidth === 80 ? [String(item.qty), money(item.pricePaise), money(item.pricePaise * item.qty)] :
      [String(item.qty), money(item.pricePaise * item.qty)];
    if (values.some((value, i) => value.length > numericWidths[i]!)) {
      line(item.name);
      pair(`${item.qty} x ${money(item.pricePaise)}`, money(item.pricePaise * item.qty));
    } else {
      row(item.name, values);
      if (paperWidth === 58) line(`  @ ${money(item.pricePaise)} each`);
    }
  });
  rule();
  pair(`Subtotal (${quantity(bill)} qty)`, money(bill.subtotalPaise));
  if (bill.discountPaise) pair("Discount", `-${money(bill.discountPaise)}`);
  if (zomatoGst) line("GST paid by Zomato (section 9(5))");
  else if (!supply) {
    // Inclusive bills still itemise GST: a tax invoice must show the rate and amount of tax.
    line(bill.taxInclusive ? inclusiveTaxNote : "GST added to menu prices");
    for (const t of bill.taxes) {
      pair(`Taxable @ ${t.gstRate}%`, money(t.taxablePaise));
      pair(`CGST @ ${t.gstRate / 2}%`, money(t.cgstPaise));
      pair(`SGST @ ${t.gstRate / 2}%`, money(t.sgstPaise));
    }
  }
  if (bill.roundingPaise) pair("Round off", money(bill.roundingPaise));
  rule().bold(true).size(1, 2);
  pair("TOTAL Rs.", money(bill.totalPaise));
  pos.size(1, 1).bold(false); rule();
  if (bill.discountNote) line(`Discount reason: ${bill.discountNote}`);
  if (bill.payments.length) {
    for (const p of bill.payments) pair(p.mode.toUpperCase(), money(p.amountPaise));
  }
  pos.bold(true);
  if (bill.status === "unpaid") pair("AMOUNT DUE Rs.", money(Math.max(0, bill.totalPaise - paidAmount(bill))));
  else line(bill.status === "paid" ? "PAID IN FULL" : "VOID - NOT PAYABLE");
  pos.bold(false); rule().align("center");
  const payment = billUpiPayment(bill);
  if (payment) {
    pos.bold(true); line(`SCAN & PAY Rs. ${money(payment.amountPaise)}`); pos.bold(false);
    const qr = upiQrRaster(payment.uri, paperWidth);
    // The bitmap already includes centered padding across the full print width.
    pos.align("left").raster(qr.widthBytes, qr.height, qr.data).align("center");
    line(`UPI: ${payment.upiId}`);
    line(`Bill #${bill.billNo}`);
    rule();
  }
  line(footer(bill));
  return finishSlip(pos, profile);
}

/** Script-free, offline A4 HTML; the UI prints a sandboxed same-origin frame. */
export function receiptHtml(bill: Bill): string {
  const r = bill.receipt;
  const style = resolveReceiptStyle(r.receiptStyle);
  const e = escape;
  const due = Math.max(0, bill.totalPaise - paidAmount(bill));
  const service = r.orderType === "zomato" ? "Zomato" : r.orderType === "parcel" ? "Takeaway / Parcel" : "Dine-in";
  const order = r.orderType === "zomato" ? `Zomato #${e(r.zomatoOrderId ?? "")}` : "Parcel";
  // Zomato collects and pays the GST on its orders (section 9(5)): the bill shows the note, never per-rate GST lines.
  const zomatoGst = r.gstPaidBy === "zomato";
  const supply = r.gstScheme === "composition";
  const payment = billUpiPayment(bill);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bill #${bill.billNo}</title><style>${RESTAURANT_RECEIPT_CSS}
  @page{@bottom-left{content:"Bill #${bill.billNo}";font:9px Arial,sans-serif;color:#71717a}}
  </style></head><body><main class="bill bill--${style}" aria-label="Restaurant bill">
  <header class="bill-header"><h1>${e(r.restaurantName)}</h1>
    ${r.address ? `<p class="address">${e(r.address)}</p>` : ""}
    <div class="registration">${r.gstin ? `<span>GSTIN: ${e(r.gstin)}</span>` : ""}${r.fssai ? `<span>FSSAI: ${e(r.fssai)}</span>` : ""}</div>
    <h2>${supply ? `Bill of supply<small class="supply-note">${compositionNote}</small>` : "Restaurant bill"}</h2></header>
  <dl class="bill-meta"><div class="date"><dt>Date</dt><dd>${e(dateTime(bill.createdAt))}</dd></div>
    <div><dt>Bill no.</dt><dd><strong>#${bill.billNo}</strong> <span class="status">${statusLabel(bill)}</span></dd></div>
    <div><dt>Service</dt><dd>${service}</dd></div>
    <div><dt>${r.orderType === "dine_in" ? "Table / Group" : "Order"}</dt><dd>${r.orderType === "dine_in" ? e(contextLine(r.orderType, r.tableName, r.splitLabel)) : order}</dd></div>
    ${bill.payments.length ? `<div><dt>Payment mode</dt><dd>${e(paymentModes(bill))}</dd></div>` : ""}</dl>
  <p class="currency-note">All amounts in INR (₹)</p>
  <table class="items" aria-label="Bill items"><thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Rate</th><th scope="col">Amount</th></tr></thead><tbody>
    ${r.items.map((i) => `<tr><td>${e(i.name)}</td><td>${i.qty}</td><td class="amount">${money(i.pricePaise)}</td><td class="amount">${money(i.pricePaise * i.qty)}</td></tr>`).join("")}
  </tbody></table>
  <section class="summary" aria-label="Bill totals"><table class="totals"><tbody>
    <tr class="subtotal"><td>Subtotal <span class="quantity">${quantity(bill)} qty</span></td><td class="amount">₹${money(bill.subtotalPaise)}</td></tr>
    ${bill.discountPaise ? `<tr><td>Discount</td><td class="amount">-₹${money(bill.discountPaise)}</td></tr>` : ""}
    ${supply ? "" : `<tr><td colspan="2" class="tax-note">${zomatoGst ? "GST paid by Zomato (section 9(5))" : bill.taxInclusive ? inclusiveTaxNote : "GST added to menu prices"}</td></tr>`}
    ${zomatoGst || supply ? "" : bill.taxes.map((t) => `<tr class="taxable"><td>Taxable @ ${t.gstRate}%</td><td class="amount">₹${money(t.taxablePaise)}</td></tr>
    <tr class="tax"><td>CGST${bill.taxInclusive ? " (included)" : ""} <small>@ ${t.gstRate / 2}%</small></td><td class="amount">₹${money(t.cgstPaise)}</td></tr>
    <tr class="tax"><td>SGST${bill.taxInclusive ? " (included)" : ""} <small>@ ${t.gstRate / 2}%</small></td><td class="amount">₹${money(t.sgstPaise)}</td></tr>`).join("")}
    ${bill.roundingPaise ? `<tr><td>Round off</td><td class="amount">₹${money(bill.roundingPaise)}</td></tr>` : ""}
    <tr class="grand-total"><td>TOTAL</td><td class="amount">₹${money(bill.totalPaise)}</td></tr>
  </tbody></table></section>
  <section class="payments" aria-label="Payment details">
    ${bill.payments.length ? `<dl>${bill.payments.map((p) => `<div><dt>${e(p.mode.toUpperCase())}</dt><dd>₹${money(p.amountPaise)}</dd></div>`).join("")}</dl>` : `<p class="tax-note">${bill.status === "paid" ? "No payment required." : bill.status === "void" ? "This bill is void." : "Payment not yet received."}</p>`}
    <p class="payment-state"><strong>${bill.status === "paid" ? "PAID IN FULL" : bill.status === "void" ? "VOID - NOT PAYABLE" : `AMOUNT DUE ₹${money(due)}`}</strong></p></section>
  ${bill.discountNote ? `<p class="discount-note">Discount reason: ${e(bill.discountNote)}</p>` : ""}
  ${payment ? `<section class="upi-payment" aria-label="UPI payment"><h2>Scan &amp; pay with UPI</h2><p class="upi-amount">₹${money(payment.amountPaise)}</p><div class="upi-qr">${upiQrSvg(payment.uri)}</div><p class="upi-id">${e(payment.upiId)}</p><p class="tax-note">Bill #${bill.billNo} · Amount filled in automatically</p></section>` : ""}
  <footer>${e(footer(bill))}</footer></main></body></html>`;
}
