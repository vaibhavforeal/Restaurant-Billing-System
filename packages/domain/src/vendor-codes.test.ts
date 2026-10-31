import { describe, expect, it } from "vitest";
import { makeVendorCode, parseVendorCode } from "./vendor-codes.js";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("vendor codes", () => {
  it("formats a prefix, four characters and three more ending in the check character", () => {
    const code = makeVendorCode("customer", bytes(7, 20, 3, 21, 9, 23));
    expect(code).toMatch(/^FC-[0-9A-Z]{4}-[0-9A-Z]{3}$/);
    expect(parseVendorCode("customer", code)).toBe(code);
    expect(makeVendorCode("order", bytes(0, 0, 0, 0, 0, 0))).toBe("FO-0000-000");
  });

  it("reads what people type: any case, spaces, no dashes, no prefix, and look-alike letters", () => {
    const code = makeVendorCode("order", bytes(1, 0, 18, 1, 0, 5));
    const body = code.slice(3).replace("-", "");
    expect(parseVendorCode("order", code.toLowerCase())).toBe(code);
    expect(parseVendorCode("order", ` ${body.slice(0, 3)} ${body.slice(3)} `)).toBe(code);
    expect(parseVendorCode("order", body.replace(/1/g, "l").replace(/0/g, "O"))).toBe(code);
    expect(parseVendorCode("order", `FO${body}`)).toBe(code);
  });

  it("rejects a typo in any single character, the wrong kind and the wrong length", () => {
    const code = makeVendorCode("customer", bytes(31, 30, 29, 28, 27, 26));
    const body = code.slice(3).replace("-", "");
    for (let i = 0; i < body.length; i++) {
      for (const replacement of "0123456789ABCDEFGHJKMNPQRSTVWXYZ") {
        if (replacement === body[i]) continue;
        expect(parseVendorCode("customer", body.slice(0, i) + replacement + body.slice(i + 1))).toBeNull();
      }
    }
    expect(parseVendorCode("order", code)).toBeNull();
    expect(parseVendorCode("customer", body.slice(1))).toBeNull();
    expect(parseVendorCode("customer", "")).toBeNull();
    expect(parseVendorCode("customer", `${body.slice(0, 6)}U`)).toBeNull();
  });
});
