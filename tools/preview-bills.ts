/** Generate deterministic samples from the production receipt renderers. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { calculateBill, RECEIPT_STYLES, type Bill } from "@forkflow/domain";
import { receiptHtml, receiptSlip } from "../apps/server/src/print/receipt.js";
import { billStyleGallery } from "./bill-style-gallery.js";

const output = resolve(".e2e-scratch/bill-design");
mkdirSync(output, { recursive: true });
const items = [
  { name: "Paneer Tikka", qty: 1, pricePaise: 24000, gstRate: 5 },
  { name: "Dal Makhani", qty: 1, pricePaise: 22000, gstRate: 5 },
  { name: "Butter Naan", qty: 4, pricePaise: 4500, gstRate: 5 },
  { name: "Vegetable Biryani - Family portion", qty: 1, pricePaise: 36000, gstRate: 5 },
  { name: "Fresh Lime Soda", qty: 2, pricePaise: 6500, gstRate: 5 },
];
const totals = calculateBill(items, 5000);
const bill: Bill = {
  ...totals, id: "preview-bill", billNo: 1042, orderId: "preview-order", status: "paid",
  createdAt: new Date(2026, 9, 9, 13, 42).getTime(), discountNote: "Loyalty discount",
  refundState: "none", creditNotes: [], refundedQty: {},
  receipt: { restaurantName: "ForkFlow Kitchen", address: "12 Market Road, Indiranagar\nBengaluru, Karnataka 560038",
    gstin: "29ABCDE1234F1Z5", fssai: "12345678901234", taxInclusive: false,
    receiptFooter: "Thank you for dining with us. See you again!\nSample bill - for layout preview only.",
    orderType: "dine_in", tableName: "T04", splitLabel: "B", items },
  payments: [{ mode: "cash", amountPaise: 50000, refNote: null, createdAt: 1 },
    { mode: "upi", amountPaise: totals.totalPaise - 50000, refNote: null, createdAt: 1 }],
};
writeFileSync(join(output, "bill-a4.html"), receiptHtml(bill));
const longItems = Array.from({ length: 52 }, (_, index) => ({ ...items[index % items.length]!, name: `${index + 1}. ${items[index % items.length]!.name}` }));
const longBill: Bill = { ...bill, ...calculateBill(longItems), status: "unpaid", payments: [], discountNote: null,
  receipt: { ...bill.receipt, items: longItems } };
writeFileSync(join(output, "bill-long.html"), receiptHtml(longBill));
writeFileSync(join(output, "bill-unpaid.html"), receiptHtml({ ...bill, status: "unpaid", payments: [] }));
writeFileSync(join(output, "bill-void.html"), receiptHtml({ ...bill, status: "void", payments: [] }));
writeFileSync(join(output, "bill-parcel.html"), receiptHtml({ ...bill,
  receipt: { ...bill.receipt, orderType: "parcel", tableName: null, splitLabel: null } }));
const inclusiveItems = [...items, { name: "Packaged soft drink", qty: 1, pricePaise: 6000, gstRate: 28 }];
const inclusiveBill: Bill = { ...bill, ...calculateBill(inclusiveItems, 5000, true),
  status: "unpaid", payments: [], receipt: { ...bill.receipt, taxInclusive: true, items: inclusiveItems } };
writeFileSync(join(output, "bill-inclusive.html"), receiptHtml(inclusiveBill));
writeFileSync(join(output, "bill-upi.html"), receiptHtml({ ...bill, status: "unpaid", payments: [],
  receipt: { ...bill.receipt, upiId: "layout-preview@upi" } }));
const largeItems = [{ name: "Special celebration catering menu with seasonal vegetables and accompaniments", qty: 100, pricePaise: 9999999, gstRate: 0 }];
writeFileSync(join(output, "bill-large.html"), receiptHtml({ ...bill, ...calculateBill(largeItems),
  status: "unpaid", payments: [], discountNote: null, receipt: { ...bill.receipt, items: largeItems } }));

// Visualize actual ESC/POS text/alignment/emphasis; this does not replace a hardware test.
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const compositionBill: Bill = { ...bill, ...calculateBill(items, 5000, false, "composition"), status: "unpaid", payments: [],
  receipt: { ...bill.receipt, gstScheme: "composition" } };
writeFileSync(join(output, "bill-composition.html"), receiptHtml(compositionBill));
const samples: [string, Bill][] = [["bill", bill], ["bill-inclusive", inclusiveBill], ["bill-composition", compositionBill]];
for (const receiptStyle of RECEIPT_STYLES) {
  for (const [mode, sample] of [["exclusive", bill], ["inclusive", inclusiveBill], ["long", longBill]] as const) {
    const styled = { ...sample, receipt: { ...sample.receipt, receiptStyle } };
    writeFileSync(join(output, `bill-${receiptStyle}-${mode}.html`), receiptHtml(styled));
    if (mode !== "long") samples.push([`bill-${receiptStyle}-${mode}`, styled]);
  }
  writeFileSync(join(output, `bill-${receiptStyle}-upi.html`), receiptHtml({ ...inclusiveBill,
    receipt: { ...inclusiveBill.receipt, receiptStyle, upiId: "layout-preview@upi" } }));
}
writeFileSync(join(output, "bill-styles.html"), billStyleGallery());
for (const [prefix, sample] of samples) {
  for (const width of [58, 80] as const) {
    const bytes = receiptSlip(sample, width);
    writeFileSync(join(output, `${prefix}-${width}mm.bin`), bytes);
    let align = "left", bold = false, tall = false, row = "", rowTall = false;
    const rows: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;
      if (byte === 27) {
        const command = bytes[++i];
        if (command === 97) align = ["left", "center", "right"][bytes[++i]!]!;
        else if (command === 69) bold = bytes[++i] === 1;
        else if (command === 100) i++;
      } else if (byte === 29) {
        const command = bytes[++i];
        if (command === 33) tall = !!(bytes[++i]! & 1);
        else if (command === 86) i += 2;
      } else if (byte === 10) {
        rows.push(`<div class="line${rowTall ? " tall" : ""}" style="text-align:${align}">${row || "&nbsp;"}</div>`);
        row = ""; rowTall = false;
      } else {
        row += `<span style="font-weight:${bold ? 700 : 400}">${escape(String.fromCharCode(byte))}</span>`;
        rowTall ||= tall;
      }
    }
    const chars = width === 58 ? 32 : 48;
    writeFileSync(join(output, `${prefix}-${width}mm.html`), `<!doctype html><html><head><meta charset="utf-8"><title>${sample.taxInclusive ? "Tax-inclusive " : ""}${width} mm receipt sample</title>
      <style>body{margin:0;padding:12px;background:#eee}.receipt{width:${chars}ch;padding:22px 12px;background:white;margin:auto;font:clamp(8px,${width === 80 ? 2.6 : 3.8}vw,14px)/1.45 'Courier New',monospace;box-sizing:content-box;box-shadow:0 2px 16px #0001}.line{white-space:pre;min-height:1.45em}.tall{line-height:2.2}.tall span{display:inline-block;transform:scaleY(1.5)}</style>
      </head><body><main class="receipt">${rows.join("")}</main></body></html>`);
  }
}
console.log(`Bill samples written to ${output}`);
