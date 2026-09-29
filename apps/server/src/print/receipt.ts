import type { Bill } from "@forkflow/domain";
import { EscPos, CHARS_PER_LINE } from "./escpos.js";
import { contextLine } from "./templates.js";

const money = (n: number) => (n / 100).toFixed(2);
const dateTime = (ms: number) => new Date(ms).toLocaleString("en-IN", { hour12: false });
// User text must never be interpreted as printer commands or HTML.
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, " ");
const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function receiptSlip(bill: Bill, paperWidth: 58 | 80): Buffer {
  const pos = new EscPos().init();
  const width = CHARS_PER_LINE[paperWidth];
  function line(value: string) {
    const safe = clean(value);
    for (let i = 0; i < safe.length; i += width) pos.line(safe.slice(i, i + width));
  }
  function pair(label: string, value: string) {
    if (label.length + value.length + 1 > width) { line(label); line(value.padStart(width)); }
    else line(label + " ".repeat(width - label.length - value.length) + value);
  }
  const r = bill.receipt;
  pos.align("center").bold(true);
  line(r.restaurantName);
  pos.bold(false);
  if (r.address) line(r.address);
  if (r.gstin) line(`GSTIN: ${r.gstin}`);
  if (r.fssai) line(`FSSAI: ${r.fssai}`);
  line(`Bill #${bill.billNo} / ${bill.status.toUpperCase()}`);
  line(dateTime(bill.createdAt));
  line(contextLine(r.orderType, r.tableName, r.splitLabel));
  line(bill.taxInclusive ? "Prices include GST" : "GST added to menu prices");
  pos.align("left").hr(width);
  for (const item of r.items) {
    line(item.name);
    pair(`${item.qty} x Rs.${money(item.pricePaise)}`, money(item.pricePaise * item.qty));
  }
  pos.hr(width);
  pair("Subtotal", money(bill.subtotalPaise));
  if (bill.discountPaise) { pair("Discount", `-${money(bill.discountPaise)}`); if (bill.discountNote) line(bill.discountNote); }
  for (const t of bill.taxes) {
    pair(`Taxable @ ${t.gstRate}%`, money(t.taxablePaise));
    pair(`CGST @ ${t.gstRate / 2}%`, money(t.cgstPaise));
    pair(`SGST @ ${t.gstRate / 2}%`, money(t.sgstPaise));
  }
  pair("Round off", money(bill.roundingPaise));
  pos.bold(true); pair("TOTAL Rs.", money(bill.totalPaise)); pos.bold(false);
  for (const p of bill.payments) pair(p.mode.toUpperCase(), money(p.amountPaise));
  pos.hr(width).align("center");
  if (r.receiptFooter) line(r.receiptFooter);
  return pos.feed(3).cut().bytes();
}

/** Script-free HTML; browser UI invokes print on a sandboxed same-origin frame. */
export function receiptHtml(bill: Bill): string {
  const r = bill.receipt;
  const e = escape;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bill #${bill.billNo}</title><style>
  body{font:14px system-ui,sans-serif;color:#111;margin:24px auto;padding:0 16px;max-width:700px}
  header{text-align:center}h1{font-size:24px;margin:8px 0}p{white-space:pre-wrap}table{border-collapse:collapse;width:100%;margin:20px 0}
  th,td{padding:8px 4px;text-align:right;border-bottom:1px solid #ddd}th:first-child,td:first-child{text-align:left;overflow-wrap:anywhere}
  .totals{margin-left:auto;max-width:350px}.total{font-size:20px;font-weight:bold}footer{text-align:center;margin-top:24px;white-space:pre-wrap}
  @media print{body{margin:0;max-width:none}tr{break-inside:avoid}} </style></head><body>
  <header><h1>${e(r.restaurantName)}</h1><p>${e(r.address)}</p>
  ${r.gstin ? `<p>GSTIN: ${e(r.gstin)}</p>` : ""}${r.fssai ? `<p>FSSAI: ${e(r.fssai)}</p>` : ""}
  <h2>Bill #${bill.billNo} · ${e(bill.status.toUpperCase())}</h2><p>${e(dateTime(bill.createdAt))}<br>${e(contextLine(r.orderType, r.tableName, r.splitLabel))}</p><p>${bill.taxInclusive ? "Prices include GST" : "GST added to menu prices"}</p></header>
  <table><thead><tr><th>Item</th><th>Qty</th><th>Rate ₹</th><th>Amount ₹</th></tr></thead><tbody>
  ${r.items.map((i) => `<tr><td>${e(i.name)}</td><td>${i.qty}</td><td>${money(i.pricePaise)}</td><td>${money(i.pricePaise * i.qty)}</td></tr>`).join("")}</tbody></table>
  <table><caption>GST breakdown (₹)</caption><thead><tr><th>GST rate</th><th>Taxable</th><th>CGST</th><th>SGST</th></tr></thead><tbody>
  ${bill.taxes.map((t) => `<tr><td>${t.gstRate}%</td><td>${money(t.taxablePaise)}</td><td>${money(t.cgstPaise)} (${t.gstRate / 2}%)</td><td>${money(t.sgstPaise)} (${t.gstRate / 2}%)</td></tr>`).join("")}</tbody></table>
  <table class="totals"><tbody><tr><td>Subtotal</td><td>₹${money(bill.subtotalPaise)}</td></tr>
  <tr><td>Discount</td><td>−₹${money(bill.discountPaise)}</td></tr><tr><td>CGST + SGST${bill.taxInclusive ? " (included)" : ""}</td><td>₹${money(bill.cgstPaise + bill.sgstPaise)}</td></tr>
  <tr><td>Round off</td><td>₹${money(bill.roundingPaise)}</td></tr><tr class="total"><td>Total</td><td>₹${money(bill.totalPaise)}</td></tr>
  ${bill.payments.map((p) => `<tr><td>${e(p.mode.toUpperCase())}</td><td>₹${money(p.amountPaise)}</td></tr>`).join("")}</tbody></table>
  ${bill.discountNote ? `<p>Discount reason: ${e(bill.discountNote)}</p>` : ""}<footer>${e(r.receiptFooter)}</footer></body></html>`;
}
