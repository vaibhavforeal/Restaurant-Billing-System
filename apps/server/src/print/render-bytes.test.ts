import { describe, expect, it } from "vitest";
import { renderBytes } from "./render-bytes.js";

describe("renderBytes", () => {
  it("renders printable ASCII literally", () => {
    const buf = Buffer.from("Hello, World! 123", "ascii");
    expect(renderBytes(buf)).toBe("Hello, World! 123");
  });

  it("renders LF as literal newline", () => {
    const buf = Buffer.from("line1\nline2\n", "ascii");
    expect(renderBytes(buf)).toBe("line1\nline2\n");
  });

  it("renders control bytes as uppercase hex <XX>", () => {
    const buf = Buffer.from([0x1b, 0x40]); // ESC @
    expect(renderBytes(buf)).toBe("<1B><40>");
  });

  it("mixed printable and control", () => {
    const buf = Buffer.concat([
      Buffer.from([0x1b, 0x61, 0x01]), // ESC a 1
      Buffer.from("TEST\n", "ascii"),
      Buffer.from([0x1d, 0x56, 0x42, 0x00]), // GS V 66 0
    ]);
    expect(renderBytes(buf)).toBe("<1B><61><01>TEST\n<1D><56><42><00>");
  });

  it("renders all printable ASCII range 0x20-0x7E literally", () => {
    const buf = Buffer.from(" !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~", "ascii");
    expect(renderBytes(buf)).toBe(" !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~");
  });

  it("renders extended ASCII (0x80+) as hex", () => {
    const buf = Buffer.from([0x80, 0xff]);
    expect(renderBytes(buf)).toBe("<80><FF>");
  });

  it("ESC @ (init with 0 params) followed by text", () => {
    const buf = Buffer.from([0x1b, 0x40, 0x54]); // ESC @ 'T'
    expect(renderBytes(buf)).toBe("<1B><40>T");
  });

  it("ESC p (drawerKick with 3 params) followed by text", () => {
    const buf = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa, 0x41]); // ESC p 0 25 250 'A'
    expect(renderBytes(buf)).toBe("<1B><70><00><19><FA>A");
  });
});
