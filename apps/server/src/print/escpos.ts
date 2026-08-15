export const CHARS_PER_LINE = { 58: 32, 80: 48 } as const;

/** Pure ESC/POS byte builder. No I/O, no deps. */
export class EscPos {
  private chunks: Buffer[] = [];

  /** ESC @ — initialize printer */
  init(): this {
    this.chunks.push(Buffer.from([0x1b, 0x40]));
    return this;
  }

  /** ESC a n — set alignment (0=left, 1=center, 2=right) */
  align(a: "left" | "center" | "right"): this {
    const map = { left: 0, center: 1, right: 2 };
    this.chunks.push(Buffer.from([0x1b, 0x61, map[a]]));
    return this;
  }

  /** ESC E n — bold on/off */
  bold(on: boolean): this {
    this.chunks.push(Buffer.from([0x1b, 0x45, on ? 0x01 : 0x00]));
    return this;
  }

  /** GS ! n — character size (w: 1 or 2, h: 1 or 2) */
  size(w: 1 | 2, h: 1 | 2): this {
    const n = ((w - 1) << 4) | (h - 1);
    this.chunks.push(Buffer.from([0x1d, 0x21, n]));
    return this;
  }

  /** Emit text (latin1-safe: non-ASCII chars replaced with '?') */
  text(s: string): this {
    const buf = Buffer.alloc(s.length);
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      buf[i] = code < 128 ? code : 0x3f; // 0x3f = '?'
    }
    this.chunks.push(buf);
    return this;
  }

  /** Emit text + LF */
  line(s?: string): this {
    if (s !== undefined) this.text(s);
    this.chunks.push(Buffer.from([0x0a])); // LF
    return this;
  }

  /** Horizontal rule: width dashes + LF (58mm=32 chars, 80mm=48 chars) */
  hr(width: 32 | 48): this {
    const dashes = "-".repeat(width);
    this.text(dashes);
    this.line();
    return this;
  }

  /** ESC d n — feed n lines */
  feed(n: number): this {
    this.chunks.push(Buffer.from([0x1b, 0x64, n]));
    return this;
  }

  /** GS V 66 0 — partial cut with feed */
  cut(): this {
    this.chunks.push(Buffer.from([0x1d, 0x56, 0x42, 0x00]));
    return this;
  }

  /** ESC p 0 25 250 — cash drawer kick pulse */
  drawerKick(): this {
    this.chunks.push(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]));
    return this;
  }

  /** Return accumulated bytes */
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
