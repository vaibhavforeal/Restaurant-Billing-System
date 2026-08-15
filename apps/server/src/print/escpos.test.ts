import { describe, expect, it } from "vitest";
import { EscPos, CHARS_PER_LINE } from "./escpos.js";

describe("EscPos", () => {
  it("init sends ESC @", () => {
    const pos = new EscPos();
    const buf = pos.init().bytes();
    expect(buf).toEqual(Buffer.from([0x1b, 0x40]));
  });

  it("align left/center/right sends ESC a 0/1/2", () => {
    const pos = new EscPos();
    expect(pos.align("left").bytes()).toEqual(Buffer.from([0x1b, 0x61, 0x00]));
    expect(new EscPos().align("center").bytes()).toEqual(Buffer.from([0x1b, 0x61, 0x01]));
    expect(new EscPos().align("right").bytes()).toEqual(Buffer.from([0x1b, 0x61, 0x02]));
  });

  it("bold on/off sends ESC E 1/0", () => {
    const pos = new EscPos();
    expect(pos.bold(true).bytes()).toEqual(Buffer.from([0x1b, 0x45, 0x01]));
    expect(new EscPos().bold(false).bytes()).toEqual(Buffer.from([0x1b, 0x45, 0x00]));
  });

  it("size sends GS ! with (w-1)<<4 | (h-1)", () => {
    const pos = new EscPos();
    expect(pos.size(1, 1).bytes()).toEqual(Buffer.from([0x1d, 0x21, 0x00]));
    expect(new EscPos().size(2, 1).bytes()).toEqual(Buffer.from([0x1d, 0x21, 0x10]));
    expect(new EscPos().size(1, 2).bytes()).toEqual(Buffer.from([0x1d, 0x21, 0x01]));
    expect(new EscPos().size(2, 2).bytes()).toEqual(Buffer.from([0x1d, 0x21, 0x11]));
  });

  it("text sends ASCII bytes, non-ASCII becomes '?'", () => {
    const pos = new EscPos();
    expect(pos.text("hello").bytes()).toEqual(Buffer.from("hello", "ascii"));
    expect(new EscPos().text("café").bytes()).toEqual(Buffer.from("caf?", "ascii"));
    expect(new EscPos().text("₹100").bytes()).toEqual(Buffer.from("?100", "ascii"));
  });

  it("line sends text + LF", () => {
    const pos = new EscPos();
    expect(pos.line("hello").bytes()).toEqual(Buffer.from("hello\n", "ascii"));
    expect(new EscPos().line().bytes()).toEqual(Buffer.from("\n", "ascii"));
  });

  it("hr sends 32 or 48 dashes + LF", () => {
    const pos = new EscPos();
    const hr32 = pos.hr(32).bytes();
    expect(hr32.toString("ascii")).toBe("-".repeat(32) + "\n");

    const hr48 = new EscPos().hr(48).bytes();
    expect(hr48.toString("ascii")).toBe("-".repeat(48) + "\n");
  });

  it("feed sends ESC d n", () => {
    const pos = new EscPos();
    expect(pos.feed(3).bytes()).toEqual(Buffer.from([0x1b, 0x64, 0x03]));
  });

  it("cut sends GS V 66 0 (partial cut w/ feed)", () => {
    const pos = new EscPos();
    expect(pos.cut().bytes()).toEqual(Buffer.from([0x1d, 0x56, 0x42, 0x00]));
  });

  it("drawerKick sends ESC p 0 25 250", () => {
    const pos = new EscPos();
    expect(pos.drawerKick().bytes()).toEqual(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]));
  });

  it("chains commands", () => {
    const pos = new EscPos();
    const buf = pos.init().align("center").bold(true).text("TEST").line().cut().bytes();
    expect(buf).toEqual(
      Buffer.concat([
        Buffer.from([0x1b, 0x40]),       // init
        Buffer.from([0x1b, 0x61, 0x01]), // center
        Buffer.from([0x1b, 0x45, 0x01]), // bold on
        Buffer.from("TEST\n", "ascii"),  // text + line
        Buffer.from([0x1d, 0x56, 0x42, 0x00]), // cut
      ])
    );
  });

  it("CHARS_PER_LINE constants", () => {
    expect(CHARS_PER_LINE[58]).toBe(32);
    expect(CHARS_PER_LINE[80]).toBe(48);
  });
});
