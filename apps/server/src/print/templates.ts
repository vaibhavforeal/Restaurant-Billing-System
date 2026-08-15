import { EscPos, CHARS_PER_LINE } from "./escpos.js";

export interface KotSlipCtx {
  kotNo: number;
  stationName: string;
  orderType: "dine_in" | "parcel";
  tableName: string | null;
  splitLabel: string | null;
  items: Array<{ qty: number; name: string; note: string | null; cancelled: boolean }>;
  atMs: number;
}

export interface CancelSlipCtx {
  kotNo: number;
  stationName: string;
  orderType: "dine_in" | "parcel";
  tableName: string | null;
  splitLabel: string | null;
  item: { qty: number; name: string };
  reason: string;
  atMs: number;
}

/** Format Unix ms as local HH:MM (24h, zero-padded) */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Context line for KOT/cancel slips (kitchen-board rule):
 * - parcel → "Parcel"
 * - dine-in → tableName when splitLabel is null or 'A', else "tableName / splitLabel"
 */
function contextLine(orderType: "dine_in" | "parcel", tableName: string | null, splitLabel: string | null): string {
  if (orderType === "parcel") return "Parcel";
  if (!splitLabel || splitLabel === "A") return tableName ?? "Table";
  return `${tableName ?? "Table"} / ${splitLabel}`;
}

export function kotSlip(ctx: KotSlipCtx, paperWidth: 58 | 80): Buffer {
  const pos = new EscPos();
  const width = CHARS_PER_LINE[paperWidth];

  pos
    .init()
    .align("center")
    .bold(true)
    .size(2, 2)
    .line(`KOT #${ctx.kotNo}`)
    .size(1, 1)
    .line(contextLine(ctx.orderType, ctx.tableName, ctx.splitLabel))
    .line(formatTime(ctx.atMs))
    .bold(false)
    .hr(width)
    .align("left");

  for (const item of ctx.items) {
    if (item.cancelled) {
      pos.bold(true).line(`CANCELLED: ${item.qty} x ${item.name}`).bold(false);
    } else {
      pos.line(`${item.qty} x ${item.name}`);
      if (item.note) {
        pos.line(`  (${item.note})`);
      }
    }
  }

  pos.hr(width).align("center").line(ctx.stationName).feed(3).cut();

  return pos.bytes();
}

export function cancelSlip(ctx: CancelSlipCtx, paperWidth: 58 | 80): Buffer {
  const pos = new EscPos();
  const width = CHARS_PER_LINE[paperWidth];

  pos
    .init()
    .align("center")
    .bold(true)
    .size(2, 2)
    .line("CANCELLED")
    .size(1, 1)
    .line(`KOT #${ctx.kotNo}`)
    .line(contextLine(ctx.orderType, ctx.tableName, ctx.splitLabel))
    .line(formatTime(ctx.atMs))
    .hr(width)
    .bold(true)
    .line(`${ctx.item.qty} x ${ctx.item.name}`)
    .bold(false)
    .line(`Reason: ${ctx.reason}`)
    .feed(3)
    .cut();

  return pos.bytes();
}
