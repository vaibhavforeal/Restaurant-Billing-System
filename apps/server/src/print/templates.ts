import { EscPos, CHARS_PER_LINE } from "./escpos.js";
import { DEFAULT_PROFILE, finishSlip } from "./profile.js";
import type { PrintProfileInput } from "@masalapos/domain";

export interface KotSlipCtx {
  kotNo: number;
  stationName: string;
  orderType: "dine_in" | "parcel" | "zomato";
  /** The restaurant's own takeaway/delivery type, shown instead of "Parcel". */
  orderTypeName?: string | null;
  zomatoOrderId?: string | null;
  tableName: string | null;
  splitLabel: string | null;
  items: Array<{ qty: number; name: string; note: string | null; cancelled: boolean }>;
  atMs: number;
}

export interface CancelSlipCtx {
  kotNo: number;
  stationName: string;
  orderType: "dine_in" | "parcel" | "zomato";
  orderTypeName?: string | null;
  zomatoOrderId?: string | null;
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
 * - parcel → the restaurant's own type name (e.g. "Home delivery"), else "Parcel"
 * - zomato → "ZOMATO #<id>"
 * - dine-in → tableName when splitLabel is null or 'A', else "tableName / splitLabel"
 */
export function contextLine(orderType: "dine_in" | "parcel" | "zomato", tableName: string | null, splitLabel: string | null, zomatoOrderId: string | null = null, orderTypeName: string | null = null): string {
  if (orderType === "parcel") return orderTypeName ?? "Parcel";
  if (orderType === "zomato") return `ZOMATO #${zomatoOrderId ?? ""}`;
  if (!splitLabel || splitLabel === "A") return tableName ?? "Table";
  return `${tableName ?? "Table"} / ${splitLabel}`;
}

export function kotSlip(ctx: KotSlipCtx, paperWidth: 58 | 80, profile: PrintProfileInput = DEFAULT_PROFILE): Buffer {
  const pos = new EscPos();
  const width = CHARS_PER_LINE[paperWidth];

  pos
    .init()
    .align("center")
    .bold(true)
    .size(2, 2)
    .line(`KOT #${ctx.kotNo}`)
    .size(1, 1)
    .line(contextLine(ctx.orderType, ctx.tableName, ctx.splitLabel, ctx.zomatoOrderId, ctx.orderTypeName ?? null))
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

  pos.hr(width).align("center").line(ctx.stationName);
  return finishSlip(pos, profile);
}

export function cancelSlip(ctx: CancelSlipCtx, paperWidth: 58 | 80, profile: PrintProfileInput = DEFAULT_PROFILE): Buffer {
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
    .line(contextLine(ctx.orderType, ctx.tableName, ctx.splitLabel, ctx.zomatoOrderId, ctx.orderTypeName ?? null))
    .line(formatTime(ctx.atMs))
    .hr(width)
    .bold(true)
    .line(`${ctx.item.qty} x ${ctx.item.name}`)
    .bold(false)
    .line(`Reason: ${ctx.reason}`);

  return finishSlip(pos, profile);
}

export interface EditSlipCtx {
  kotNo: number;
  /** The slip's context line, from `contextLine`. */
  context: string;
  name: string;
  oldQty: number;
  newQty: number;
  oldNote: string | null;
  newNote: string | null;
  reason: string | null;
  atMs: number;
}

/** A sent item was changed: the kitchen sees the old and new quantity and note side by side. */
export function editSlip(ctx: EditSlipCtx, paperWidth: 58 | 80, profile: PrintProfileInput = DEFAULT_PROFILE): Buffer {
  const pos = new EscPos();
  const width = CHARS_PER_LINE[paperWidth];

  pos
    .init()
    .align("center")
    .bold(true)
    .size(2, 2)
    .line("CHANGED")
    .size(1, 1)
    .line(`KOT #${ctx.kotNo}`)
    .line(ctx.context)
    .line(formatTime(ctx.atMs))
    .hr(width)
    .align("left")
    .bold(true)
    .line(ctx.name)
    .bold(false);
  if (ctx.newQty !== ctx.oldQty) pos.bold(true).line(`Qty: ${ctx.oldQty} -> ${ctx.newQty}`).bold(false);
  else pos.line(`Qty: ${ctx.newQty}`);
  if (ctx.newNote !== ctx.oldNote) {
    pos.line(`Was: ${ctx.oldNote ?? "(no note)"}`);
    pos.bold(true).line(`Now: ${ctx.newNote ?? "(no note)"}`).bold(false);
  }
  if (ctx.reason) pos.line(`Reason: ${ctx.reason}`);

  return finishSlip(pos, profile);
}

export interface TableChangeSlipCtx {
  stationName: string;
  /** Printable text only (ASCII): the thermal encoder replaces other characters, e.g. "T3 -> T7" or "T3, T4". */
  text: string;
  atMs: number;
}

export function tableChangeSlip(ctx: TableChangeSlipCtx, paperWidth: 58 | 80, profile: PrintProfileInput = DEFAULT_PROFILE): Buffer {
  const pos = new EscPos();
  const width = CHARS_PER_LINE[paperWidth];

  pos
    .init()
    .align("center")
    .bold(true)
    .line("TABLE CHANGE")
    .line(ctx.stationName)
    .size(2, 2)
    .line(ctx.text)
    .size(1, 1)
    .line(formatTime(ctx.atMs))
    .bold(false)
    .hr(width);

  return finishSlip(pos, profile);
}
