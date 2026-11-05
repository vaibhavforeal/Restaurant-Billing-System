/** What "Write description" / "Rewrite" sends: the dish details, plus the current text when there is some to improve. */
export function describeRequest(product: { name: string; categoryName: string; isVeg: boolean; variantNames: string[]; description: string }):
  { name: string; category: string; isVeg: boolean; sizes: string[]; current?: string } {
  const current = product.description.trim();
  return { name: product.name.trim(), category: product.categoryName, isVeg: product.isVeg, sizes: product.variantNames, ...(current ? { current } : {}) };
}

/** The day summary as copied for WhatsApp: a heading line, then the bullet points. */
export const summaryClipboardText = (date: string, restaurant: string, text: string) => `${restaurant} · ${date}\n${forWhatsApp(text)}`;
/** WhatsApp's own formatting: *bold*, and "• " bullets in place of Markdown's "- " or "* ". */
const forWhatsApp = (text: string) => text.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "*$1*").replace(/^(\s*)[-*]\s+/gm, "$1• ");
