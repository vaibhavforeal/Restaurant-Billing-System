export type KeypadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "back";

/** Applies one key to a typed rupee amount: one point, at most two decimals and seven digits before the point. */
export function pressKey(text: string, key: KeypadKey): string {
  if (key === "back") return text.slice(0, -1);
  if (key === ".") return text.includes(".") ? text : `${text || "0"}.`;
  const [whole = "", decimals] = text.split(".");
  if (decimals !== undefined) return decimals.length >= 2 ? text : text + key;
  if (whole.length >= 7) return text;
  return whole === "0" ? key : text + key;
}
