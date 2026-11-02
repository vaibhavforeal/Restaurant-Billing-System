import { describe, expect, it } from "vitest";
import { csvField, parseCsv, toCsv, unescapeCsvField } from "./csv.js";

describe("CSV", () => {
  it("keeps numbers numeric but stops text a spreadsheet would run as a formula", () => {
    expect(csvField(-12.5)).toBe('"-12.5"');
    expect(csvField("-12.50")).toBe('"-12.50"');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField(" +1")).toBe(`"' +1"`);
    expect(csvField("@sum")).toBe(`"'@sum"`);
    expect(csvField("'quoted")).toBe(`"''quoted"`);
    expect(csvField(null)).toBe('""');
  });

  it("writes a byte-order mark and CRLF lines, and reads back exactly what it wrote", () => {
    const rows = [["name", "note"], ["Tea, large", 'Say "hi"\r\nthen leave'], ["=1+1", "-5"], ["'kept", "@x"]];
    const text = toCsv(rows);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.endsWith("\r\n")).toBe(true);
    const back = parseCsv(text, 10, "too many").map((r) => r.cells.map(unescapeCsvField));
    expect(back).toEqual(rows);
  });

  it("numbers rows by the line they start on and skips blank rows", () => {
    expect(parseCsv('a,b\n\n"x\ny",1\n2,3\n', 10, "too many").map((r) => r.line)).toEqual([1, 3, 5]);
  });

  it("reports malformed input and too many rows", () => {
    expect(() => parseCsv('a\n"b', 10, "too many")).toThrow("Row 2: unclosed quoted field.");
    expect(() => parseCsv('a\n"b"c', 10, "too many")).toThrow("Row 2: unexpected text after a closing quote.");
    expect(() => parseCsv('a\nb"c"', 10, "too many")).toThrow("quotes must start at the beginning of a field.");
    expect(() => parseCsv("h\n1\n2\n3\n", 2, "Import up to 2 rows.")).toThrow("Import up to 2 rows.");
    expect(parseCsv("h\n1\n2\n", 2, "too many")).toHaveLength(3);
  });
});
