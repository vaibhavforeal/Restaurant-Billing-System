import type { AddonSnapshot } from "./types";

export interface DraftItem {
  clientRef: string;
  productId: string;
  variantId: string | null;
  name: string;
  pricePaise: number;
  qty: number;
  note: string;
  comboPicks?: string[];
  addonPicks?: string[];
  addons?: AddonSnapshot[];
  contents?: string[];
  held?: boolean;
}

type NewDraftItem = Omit<DraftItem, "clientRef" | "note">;
const MAX_LINE_QUANTITY = 99;

function samePicks(left: string[] = [], right: string[] = []): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((pick, index) => pick === sortedRight[index]);
}

export function addDraftRows(
  draft: DraftItem[],
  additions: NewDraftItem[],
  queuedRefs: ReadonlySet<string>,
  createRef: () => string,
): DraftItem[] {
  const next = [...draft];
  for (const addition of additions) {
    let remaining = addition.qty;
    for (const [index, item] of next.entries()) {
      if (remaining === 0) break;
      if (item.held || addition.held || item.note || queuedRefs.has(item.clientRef) || item.qty >= MAX_LINE_QUANTITY) continue;
      if (item.productId !== addition.productId || item.variantId !== addition.variantId || item.pricePaise !== addition.pricePaise) continue;
      if (!samePicks(item.comboPicks, addition.comboPicks) || !samePicks(item.addonPicks, addition.addonPicks)) continue;
      const count = Math.min(remaining, MAX_LINE_QUANTITY - item.qty);
      next[index] = { ...item, qty: item.qty + count };
      remaining -= count;
    }
    while (remaining > 0) {
      const qty = Math.min(remaining, MAX_LINE_QUANTITY);
      next.push({ ...addition, clientRef: createRef(), note: "", qty });
      remaining -= qty;
    }
  }
  return next;
}
