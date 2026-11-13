import { describe, expect, it } from "vitest";
import { toBase64 } from "./base64";

describe("toBase64", () => {
  it.each([[[], ""], [[0x4d], "TQ=="], [[0x4d, 0x61], "TWE="], [[0x4d, 0x61, 0x6e], "TWFu"], [[0x1b, 0x40, 0xff, 0x00, 0x0a], "G0D/AAo="]])("encodes %j", (bytes, text) => {
    expect(toBase64(Uint8Array.from(bytes))).toBe(text);
  });
  it("matches Node for a receipt-sized buffer", () => {
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * 37) % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
