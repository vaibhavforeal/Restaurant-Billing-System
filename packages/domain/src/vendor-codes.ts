// Customer IDs and Order IDs that the MasalaPOS Portal issues and a counter asks for at setup. Shared by the licensing Worker,
// the counter server and its UI, so a typo is caught before anything goes over the network. WebCrypto-free and DOM-free.

/** Crockford base32: no I, L, O or U, so a code read over the phone has no look-alikes. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX = { customer: "FC", order: "FO" } as const;
/** Six random characters (about a billion codes per kind) and one check character. */
const RANDOM_LENGTH = 6;
const BODY_LENGTH = RANDOM_LENGTH + 1;

export type VendorCodeKind = keyof typeof PREFIX;

// Odd weights are invertible mod 32, so changing any single character always changes the check character.
const checkValue = (values: number[]) => values.reduce((sum, v, i) => sum + v * (2 * i + 1), 0) % 32;
const format = (kind: VendorCodeKind, body: string) => `${PREFIX[kind]}-${body.slice(0, 4)}-${body.slice(4)}`;

/** A fresh code from at least six random bytes, e.g. `FC-7K3M-9QX`. Callers retry on the (rare) unique-constraint collision. */
export function makeVendorCode(kind: VendorCodeKind, random: Uint8Array): string {
  if (random.length < RANDOM_LENGTH) throw new Error("makeVendorCode needs six random bytes");
  const values = Array.from(random.subarray(0, RANDOM_LENGTH), (byte) => byte % 32);
  return format(kind, [...values, checkValue(values)].map((v) => ALPHABET[v]).join(""));
}

/**
 * The canonical form of a code someone typed, or null when it is not a valid code of that kind. Case, spaces and dashes are
 * ignored, the prefix is optional, and I/L read as 1 and O as 0.
 */
export function parseVendorCode(kind: VendorCodeKind, input: string): string | null {
  let text = input.toUpperCase().replace(/[\s-]+/g, "");
  // The prefix comes off before look-alikes are mapped: the O in "FO" is a letter.
  if (text.length === PREFIX[kind].length + BODY_LENGTH && text.startsWith(PREFIX[kind])) text = text.slice(PREFIX[kind].length);
  text = text.replace(/[IL]/g, "1").replace(/O/g, "0");
  if (text.length !== BODY_LENGTH) return null;
  const values = Array.from(text, (char) => ALPHABET.indexOf(char));
  if (values.some((v) => v < 0)) return null;
  return values[RANDOM_LENGTH] === checkValue(values.slice(0, RANDOM_LENGTH)) ? format(kind, text) : null;
}
