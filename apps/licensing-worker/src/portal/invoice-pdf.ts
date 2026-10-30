import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { InvoiceDetail } from "./api-types.js";
import { formatPaise } from "./shared.js";

// A4 in points, with 40pt margins.
const W = 595.28, H = 841.89, M = 40;
const INK = rgb(0.09, 0.09, 0.1), MUTED = rgb(0.37, 0.39, 0.41), LINE = rgb(0.85, 0.85, 0.86), RED = rgb(0.725, 0.137, 0.208);
const IST = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });

/**
 * The standard PDF fonts only carry the Windows-1252 characters; anything else (the rupee sign, Indian scripts, emoji) would throw,
 * so it is replaced: typographic marks by their plain forms, everything else by "?". Money is written "Rs." for the same reason.
 */
function plain(font: PDFFont, text: string): string {
  const supported = new Set(font.getCharacterSet());
  return text.replace(/₹/g, "Rs.").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/•/g, "-")
    .replace(/\r/g, "").split("").map((c) => (c === "\n" || supported.has(c.codePointAt(0)!) ? c : "?")).join("");
}

function wrap(font: PDFFont, size: number, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      // A word longer than the column (a long email) is cut where it overflows.
      while (font.widthOfTextAtSize(line, size) > width) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut)); line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function invoicePdf(invoice: InvoiceDetail): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Tax invoice ${invoice.number}`); doc.setAuthor(invoice.seller.name); doc.setCreator("ForkFlow Portal"); doc.setProducer("ForkFlow Portal");
  doc.setCreationDate(new Date(invoice.issuedAt)); doc.setModificationDate(new Date(invoice.issuedAt));
  const regular = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const text = (value: string, x: number, at: number, o: { size?: number; font?: PDFFont; color?: typeof INK; right?: boolean } = {}) => {
    const font = o.font ?? regular, size = o.size ?? 9, safe = plain(font, value);
    page.drawText(safe, { x: o.right ? x - font.widthOfTextAtSize(safe, size) : x, y: at, size, font, color: o.color ?? INK });
  };
  const block = (value: string, x: number, width: number, o: { size?: number; font?: PDFFont; color?: typeof INK; leading?: number } = {}) => {
    const font = o.font ?? regular, size = o.size ?? 9, leading = o.leading ?? size + 3;
    for (const line of wrap(font, size, plain(font, value), width)) { text(line, x, y, { ...o, size, font }); y -= leading; }
  };
  const rule = (at: number) => page.drawLine({ start: { x: M, y: at }, end: { x: W - M, y: at }, thickness: 0.6, color: LINE });
  const money = (paise: number) => formatPaise(paise);

  // Seller on the left, the document on the right.
  const top = y;
  text(invoice.seller.name, M, y, { size: 15, font: bold }); y -= 18;
  block(invoice.seller.address, M, 300, { color: MUTED });
  block(`${invoice.seller.stateName ?? ""}${invoice.seller.stateCode ? ` (state code ${invoice.seller.stateCode})` : ""}`, M, 300, { color: MUTED });
  if (invoice.seller.gstin) block(`GSTIN ${invoice.seller.gstin}`, M, 300, { font: bold });
  const contact = [invoice.seller.email, invoice.seller.phone].filter(Boolean).join("  ·  ");
  if (contact) block(contact, M, 300, { color: MUTED });
  const sellerBottom = y;
  y = top;
  text("TAX INVOICE", W - M, y, { size: 16, font: bold, right: true, color: invoice.cancelledAt ? RED : INK }); y -= 20;
  for (const [label, value] of [["Invoice no.", invoice.number], ["Invoice date", IST.format(invoice.issuedAt)], ["Order ID", invoice.orderCode],
    ["Customer ID", invoice.buyer.code], ["Place of supply", invoice.placeOfSupply], ["Reverse charge", "No"]] as const) {
    text(label, W - M - 150, y, { color: MUTED }); text(value, W - M, y, { right: true, font: bold }); y -= 13;
  }
  if (invoice.cancelledAt) { y -= 4; text(`CANCELLED on ${IST.format(invoice.cancelledAt)}`, W - M, y, { right: true, font: bold, color: RED }); y -= 13; }
  y = Math.min(y, sellerBottom) - 12;
  rule(y); y -= 18;

  // The buyer.
  text("Bill to", M, y, { color: MUTED }); y -= 14;
  text(invoice.buyer.name, M, y, { size: 11, font: bold }); y -= 14;
  if (invoice.buyer.address) block(invoice.buyer.address, M, 330);
  block(`${invoice.buyer.stateName ?? ""}${invoice.buyer.stateCode ? ` (state code ${invoice.buyer.stateCode})` : ""}`, M, 330);
  block(invoice.buyer.gstin ? `GSTIN ${invoice.buyer.gstin}` : "Unregistered: no GSTIN", M, 330, { font: invoice.buyer.gstin ? bold : regular });
  y -= 10;

  // Lines: description, SAC, quantity, rate, taxable value.
  const cols = { n: M, desc: M + 18, sac: 330, qty: 400, rate: 470, value: W - M };
  const header = () => {
    page.drawRectangle({ x: M, y: y - 5, width: W - 2 * M, height: 18, color: rgb(0.96, 0.96, 0.96) });
    text("#", cols.n + 2, y, { font: bold, size: 8 }); text("Description", cols.desc, y, { font: bold, size: 8 }); text("SAC/HSN", cols.sac, y, { font: bold, size: 8 });
    text("Qty", cols.qty, y, { font: bold, size: 8, right: true }); text("Rate", cols.rate, y, { font: bold, size: 8, right: true });
    text("Taxable value", cols.value, y, { font: bold, size: 8, right: true });
    y -= 20;
  };
  header();
  invoice.lines.forEach((line, i) => {
    const description = wrap(regular, 9, plain(regular, line.description), cols.sac - cols.desc - 12);
    const height = description.length * 12 + (line.discountPaise ? 12 : 0) + 8;
    if (y - height < 200) { page = doc.addPage([W, H]); y = H - M; header(); }
    text(String(i + 1), cols.n + 2, y);
    description.forEach((d, j) => text(d, cols.desc, y - j * 12));
    text(line.sac, cols.sac, y); text(String(line.quantity), cols.qty, y, { right: true });
    text(money(line.unitPricePaise), cols.rate, y, { right: true }); text(money(line.taxablePaise + line.discountPaise), cols.value, y, { right: true });
    y -= description.length * 12;
    if (line.discountPaise) { text("Less discount", cols.desc, y, { color: MUTED }); text(`-${money(line.discountPaise)}`, cols.value, y, { right: true, color: MUTED }); y -= 12; }
    y -= 6; rule(y + 4); y -= 8;
  });

  // Totals, with the tax split by kind and rate.
  const rates = [...new Set(invoice.lines.map((l) => l.gstRateBp))];
  const rate = (share: number) => (rates.length === 1 ? ` @ ${((rates[0]! * share) / 100).toFixed(rates[0]! * share % 100 ? 1 : 0)}%` : "");
  const totals: Array<[string, number, boolean]> = [["Taxable value", invoice.subtotalPaise, false],
    ...(invoice.intraState ? [[`CGST${rate(0.5)}`, invoice.cgstPaise, false], [`SGST${rate(0.5)}`, invoice.sgstPaise, false]] as Array<[string, number, boolean]>
      : [[`IGST${rate(1)}`, invoice.igstPaise, false]] as Array<[string, number, boolean]>),
    ["Total", invoice.totalPaise, true]];
  for (const [label, value, strong] of totals) {
    text(label, cols.rate - 60, y, { font: strong ? bold : regular, size: strong ? 11 : 9 });
    text(money(value), cols.value, y, { right: true, font: strong ? bold : regular, size: strong ? 11 : 9 });
    y -= strong ? 18 : 13;
  }
  y -= 4;
  block(`Amount in words: ${invoice.amountInWords}`, M, W - 2 * M, { font: bold });
  y -= 10;
  if (invoice.seller.bankDetails) { text("Pay by bank transfer", M, y, { color: MUTED }); y -= 13; block(invoice.seller.bankDetails, M, 300); y -= 6; }
  if (invoice.seller.terms) { text("Terms", M, y, { color: MUTED }); y -= 13; block(invoice.seller.terms, M, W - 2 * M); }

  // Closing, on the last page.
  text(`For ${invoice.seller.name}`, W - M, 90, { right: true, font: bold });
  text("Authorised signatory", W - M, 60, { right: true, color: MUTED });
  text("This is a computer-generated invoice.", M, 60, { color: MUTED, size: 8 });
  return doc.save({ useObjectStreams: false });
}
