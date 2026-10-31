import { makeVendorCode, type VendorCodeKind } from "@masalapos/domain/vendor-codes";

/**
 * Runs `insert(code)` with fresh random codes until one is not taken: a Customer ID or Order ID collides about once in a billion, so
 * one retry is already rare. Any other failure is thrown at once.
 */
export async function withFreshCode<T>(kind: VendorCodeKind, insert: (code: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const code = makeVendorCode(kind, crypto.getRandomValues(new Uint8Array(6)));
    try { return await insert(code); }
    catch (error) {
      if (attempt < 4 && error instanceof Error && /UNIQUE constraint failed: \w+\.code/.test(error.message)) continue;
      throw error;
    }
  }
}
