/** Generate deterministic samples from the production receipt renderers. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { calculateBill, type Bill } from "@forkflow/domain";
import { receiptHtml, receiptSlip } from "../apps/server/src/print/receipt.js";

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
  createdAt: new Date(2026, 8, 29, 13, 42).getTime(), discountNote: "Loyalty discount",
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

// Visualize actual ESC/POS text/alignment/emphasis; this does not replace a hardware test.
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
for (const width of [58, 80] as const) {
  const bytes = receiptSlip(bill, width);
  writeFileSync(join(output, `bill-${width}mm.bin`), bytes);
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
  writeFileSync(join(output, `bill-${width}mm.html`), `<!doctype html><html><head><meta charset="utf-8"><title>${width} mm receipt sample</title>
    <style>body{margin:0;padding:24px;background:#eee}.receipt{width:${chars}ch;padding:22px 16px;background:white;margin:auto;font:14px/1.45 'Courier New',monospace;box-sizing:content-box;box-shadow:0 2px 16px #0001}.line{white-space:pre;min-height:1.45em}.tall{line-height:2.2}.tall span{display:inline-block;transform:scaleY(1.5)}</style>
    </head><body><main class="receipt">${rows.join("")}</main></body></html>`);
}
console.log(`Bill samples written to ${output}`);
