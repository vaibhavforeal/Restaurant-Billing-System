/** Spreadsheet-safe CSV, shared by every MasalaPOS export and import. */

// Text a spreadsheet would run as a formula (or that starts with our own escape).
const FORMULA = /^(?:\s*[=+\-@]|[\t\r\n'])/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

export type CsvCell = string | number | null | undefined;

/**
 * One quoted field. Numbers, and text that is just a number (such as "-12.50"), stay numbers in a spreadsheet; any other text that
 * would run as a formula gets a leading apostrophe, which `unescapeCsvField` takes off again on import.
 */
export function csvField(value: CsvCell): string {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = typeof value !== "number" && !PLAIN_NUMBER.test(text) && FORMULA.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}

/** A whole file: a byte-order mark (so Excel reads UTF-8), every field quoted, CRLF line ends. */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return "\uFEFF" + rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** Takes off only an apostrophe that `csvField` could have added. */
export function unescapeCsvField(value: string): string {
  return value.startsWith("'") && FORMULA.test(value.slice(1)) ? value.slice(1) : value;
}

/**
 * Reads RFC 4180 CSV (byte-order mark, quoted commas and line breaks, doubled quotes, CRLF or LF) into rows of raw fields, each
 * with the line it starts on. Blank rows are skipped. Malformed input throws "Row N: ...", and more than `maxRows` rows after the
 * header throws `tooMany`.
 */
export function parseCsv(source: string, maxRows: number, tooMany: string): { line: number; cells: string[] }[] {
  const input = source.replace(/^\uFEFF/, "");
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [], field = "", quoted = false, closed = false, line = 1, startLine = 1;
  const fail = (message: string): never => { throw new Error(`Row ${line}: ${message}`); };
  const endField = () => { cells.push(field); field = ""; closed = false; };
  const endRow = () => {
    endField();
    if (cells.some((cell) => cell.trim() !== "")) rows.push({ line: startLine, cells });
    if (rows.length > maxRows + 1) throw new Error(tooMany);
    cells = []; startLine = line + 1;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else { field += ch; if (ch === "\n") line++; }
    } else if (ch === ",") endField();
    else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      endRow(); line++;
    } else if (closed) fail("unexpected text after a closing quote.");
    else if (ch === '"') {
      if (field !== "") fail("quotes must start at the beginning of a field.");
      quoted = true;
    } else field += ch;
  }
  if (quoted) fail("unclosed quoted field.");
  if (field || cells.length || closed) endRow();
  return rows;
}
