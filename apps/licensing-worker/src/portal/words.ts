// Invoice wording: an amount in words in the Indian system (lakh, crore), and the Indian financial year.

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number): string {
  return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ""}`;
}
function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100), rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : "", rest ? belowHundred(rest) : ""].filter(Boolean).join(" ");
}
/** Whole numbers in words with crore, lakh and thousand. */
export function numberInWords(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000), lakh = Math.floor((n % 10_000_000) / 100_000), thousand = Math.floor((n % 100_000) / 1000), rest = n % 1000;
  if (crore) parts.push(`${numberInWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(" ");
}

/** "Rupees Forty-Three Thousand Sixty-Seven and Sixty-Four Paise Only" */
export function rupeesInWords(paise: number): string {
  const rupees = Math.floor(paise / 100), rest = paise % 100;
  return `Rupees ${numberInWords(rupees)}${rest ? ` and ${belowHundred(rest)} Paise` : ""} Only`;
}

const IST_OFFSET_MS = 330 * 60_000;
/** The Indian financial year (April to March) a moment falls in, as "26-27". */
export function financialYear(at: number): string {
  const local = new Date(at + IST_OFFSET_MS);
  const start = local.getUTCMonth() >= 3 ? local.getUTCFullYear() : local.getUTCFullYear() - 1;
  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
}
