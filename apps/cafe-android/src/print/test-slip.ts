import { CHARS_PER_LINE, DEFAULT_PROFILE, EscPos, clean, dateTime, finishSlip } from "@masalapos/print";

/** A short slip to check a printer: the cafe's name, a numbered ruler exactly one line wide, and the time. */
export function testSlip(cafeName: string, paperWidth: 58 | 80, now: number): Uint8Array {
  const width = CHARS_PER_LINE[paperWidth];
  const ruler = Array.from({ length: width }, (_, i) => String((i + 1) % 10)).join("");
  const pos = new EscPos().init().align("center").bold(true).line(clean(cafeName).slice(0, width)).bold(false)
    .line("Printer test").line(`${paperWidth} mm paper, ${width} characters`).align("left").line(ruler)
    .line(dateTime(now)).line("One line of numbers above").line("means the width is right.");
  return finishSlip(pos, DEFAULT_PROFILE);
}
