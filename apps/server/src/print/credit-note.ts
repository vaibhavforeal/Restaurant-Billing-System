import { receiptGstMode, type Bill, type BillCreditNote, type PrintProfileInput, type TaxLine } from "@forkflow/domain";
import { DEFAULT_PROFILE, finishSlip } from "./profile.js";
import { EscPos, CHARS_PER_LINE } from "./escpos.js";
import { RECEIPT_CSS } from "./receipt-style.js";
import { dateTime, escape, money, slipWriter } from "./receipt.js";

/** A credit note as printed: the bill JSON's credit note plus its per-rate taxes (which the bill JSON does not carry). */
export interface CreditNoteView extends BillCreditNote { taxes: TaxLine[] }

const cnLabel = (note: CreditNoteView) => `CN-${note.cnNo}`;
/** A void of an unpaid bill refunds nothing: the bill is simply cancelled. */
const isUnpaidVoid = (note: CreditNoteView) => note.kind === "void" && note.refunds.length === 0;
const roundingOf = (note: CreditNoteView) => note.totalPaise - note.taxablePaise - note.cgstPaise - note.sgstPaise;

export function creditNoteSlip(note: CreditNoteView, bill: Bill, paperWidth: 58 | 80, profile: PrintProfileInput = DEFAULT_PROFILE): Buffer {
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
  line(`CREDIT NOTE ${cnLabel(note)}`);
  pos.bold(false).align("left");
  line(dateTime(note.createdAt));
  line(`Against Bill #${bill.billNo}`);
  line(`Bill date: ${dateTime(bill.createdAt)}`);
  pos.hr(width).bold(true);
  pair("ITEM / QTY", "AMOUNT");
  pos.bold(false);
  line("All amounts in Rs.");
  pos.hr(width);
  if (note.lines.length === 0) line("All items on the bill");
  note.lines.forEach((item, index) => {
    pos.bold(true); line(`${index + 1}. ${item.name}`); pos.bold(false);
    pair(`Qty ${item.qty}`, money(item.totalPaise));
  });
  pos.hr(width);
  // A bill that charged no GST (no-GST restaurant or Zomato) has a credit note with none either.
  if (receiptGstMode(r) === "included") for (const t of note.taxes) {
    pair(`Taxable @ ${t.gstRate}%`, money(t.taxablePaise));
    pair(`CGST ${t.gstRate / 2}%`, money(t.cgstPaise));
    pair(`SGST ${t.gstRate / 2}%`, money(t.sgstPaise));
  }
  if (roundingOf(note)) pair("Round off", money(roundingOf(note)));
  pos.hr(width).bold(true);
  if (isUnpaidVoid(note)) {
    line("BILL VOIDED");
    pos.bold(false);
    pair("Bill value Rs.", money(note.totalPaise));
  } else {
    pos.size(1, 2);
    pair("TOTAL REFUNDED Rs.", money(note.totalPaise));
    pos.size(1, 1).bold(false);
    for (const p of note.refunds) {
      pair(`${p.mode.toUpperCase()} refund`, money(p.amountPaise));
      if (p.refNote) line(`Ref: ${p.refNote}`);
    }
  }
  pos.bold(false).hr(width);
  line(`Reason: ${note.reason}`);
  line(`Approved by ${note.approvedByName}`);
  return finishSlip(pos, profile);
}

/** Script-free, offline A4 HTML in the bill receipt's style; the UI prints a sandboxed same-origin frame. */
export function creditNoteHtml(note: CreditNoteView, bill: Bill): string {
  const r = bill.receipt;
  const e = escape;
  const label = cnLabel(note);
  const unpaidVoid = isUnpaidVoid(note);
  const rounding = roundingOf(note);
  const supply = receiptGstMode(r) !== "included";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Credit note ${label}</title><style>${RECEIPT_CSS}
  .items th:nth-child(3),.items td:nth-child(3){width:14%}.items th:last-child,.items td:last-child{width:37%}
  @page{@bottom-left{content:"${label}";font:9px Arial,sans-serif;color:#71717a}}
  </style></head><body><main class="bill" aria-label="Credit note">
  <header class="bill-header"><div><h1>${e(r.restaurantName)}</h1>
    ${r.address ? `<p class="address">${e(r.address)}</p>` : ""}
    <div class="registration">${r.gstin ? `<span>GSTIN: ${e(r.gstin)}</span>` : ""}${r.fssai ? `<span>FSSAI: ${e(r.fssai)}</span>` : ""}</div>
  </div><div class="bill-identity"><p class="eyebrow">Credit note</p><p class="bill-number">${label}</p><span class="status">${unpaidVoid ? "BILL VOIDED" : note.kind === "void" ? "VOID" : "REFUND"}</span></div></header>
  <dl class="bill-meta"><div><dt>Issued on</dt><dd>${e(dateTime(note.createdAt))}</dd></div><div><dt>Against bill</dt><dd>Bill #${bill.billNo}</dd></div>
    <div><dt>Bill date</dt><dd>${e(dateTime(bill.createdAt))}</dd></div></dl>
  <table class="items" aria-label="Credited items"><thead><tr><th scope="col">#</th><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Amount ₹</th></tr></thead><tbody>
    ${note.lines.length ? note.lines.map((i, index) => `<tr><td>${index + 1}</td><td><span class="item-name">${e(i.name)}</span></td><td>${i.qty}</td><td class="amount"><strong>${money(i.totalPaise)}</strong></td></tr>`).join("") : `<tr><td></td><td><span class="item-name">All items on the bill</span></td><td></td><td class="amount"><strong>${money(note.totalPaise)}</strong></td></tr>`}
  </tbody></table><div class="item-count"><span>${note.lines.reduce((sum, l) => sum + l.qty, 0)} total quantity credited</span><span>All amounts in INR</span></div>
  <div class="summary">${supply ? `<section aria-label="GST"><p class="tax-note">No GST was charged on this bill.</p></section>` : `<section aria-label="GST breakdown"><h2 class="section-title">GST breakdown (₹)</h2>
    <table class="taxes"><thead><tr><th scope="col">GST</th><th scope="col">Taxable</th><th scope="col">CGST</th><th scope="col">SGST</th></tr></thead><tbody>
    ${note.taxes.map((t) => `<tr><td>${t.gstRate}%</td><td>${money(t.taxablePaise)}</td><td>${money(t.cgstPaise)}<br><small>${t.gstRate / 2}%</small></td><td>${money(t.sgstPaise)}<br><small>${t.gstRate / 2}%</small></td></tr>`).join("")}
    </tbody></table>
  </section>`}<section aria-label="Credit note totals"><table class="totals"><tbody>
    ${supply ? `<tr><td>Item value</td><td class="amount">₹${money(note.taxablePaise)}</td></tr>` : `<tr><td>Taxable value</td><td class="amount">₹${money(note.taxablePaise)}</td></tr>
    <tr><td>CGST</td><td class="amount">₹${money(note.cgstPaise)}</td></tr>
    <tr><td>SGST</td><td class="amount">₹${money(note.sgstPaise)}</td></tr>`}
    ${rounding ? `<tr><td>Round off</td><td class="amount">₹${money(rounding)}</td></tr>` : ""}
    <tr class="grand-total"><td>${unpaidVoid ? "Bill value" : "Total refunded"}</td><td class="amount">₹${money(note.totalPaise)}</td></tr>
  </tbody></table></section></div>
  <section class="payments" aria-label="Refund details"><div><h2 class="section-title">Refund details</h2>
    ${note.refunds.length ? `<div class="payment-methods">${note.refunds.map((p) => `<span><b>${e(p.mode.toUpperCase())}</b> ₹${money(p.amountPaise)}${p.refNote ? ` (${e(p.refNote)})` : ""}</span>`).join("")}</div>` : `<p class="tax-note">Nothing was paid on this bill, so there is nothing to refund.</p>`}
  </div><div class="payment-state"><strong>${unpaidVoid ? "BILL VOIDED" : "TOTAL REFUNDED"}</strong></div></section>
  <p class="discount-note">Reason: ${e(note.reason)}</p>
  <footer>Approved by ${e(note.approvedByName)}</footer></main></body></html>`;
}
