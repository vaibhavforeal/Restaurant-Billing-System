/** Spreadsheet-friendly catalog exchange. Prices in this format are rupees. */
export const CATALOG_CSV_LIMIT = 5 * 1024 * 1024;
export const CATALOG_CSV_COLUMNS = [
  "item_id", "category", "name", "price", "gst_rate", "is_veg", "is_active",
  "is_sold_out", "description", "kot_station", "variant_id", "variant_name",
  "variant_price", "variant_active", "ac_price", "takeaway_price", "variant_ac_price", "variant_takeaway_price",
] as const;
export type CatalogCsvColumn = typeof CATALOG_CSV_COLUMNS[number];
export interface CatalogImportPreview {
  revision: string;
  created: number;
  updated: number;
  categoriesCreated: number;
  variantsCreated: number;
  variantsUpdated: number;
  items: { name: string; category: string; pricePaise: number; action: "Add" | "Update" }[];
}

// Quote every field and neutralize spreadsheet formulas, including leading whitespace.
// Doubling an existing leading apostrophe makes this escaping reversible on import.
const unsafeCell = /^(?:\s*[=+\-@]|[\t\r\n'])/;
export function catalogCsv(rows: readonly (readonly string[])[]): string {
  return "\uFEFF" + rows.map((row) => row.map((value) => {
    const safe = unsafeCell.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(",")).join("\r\n") + "\r\n";
}

/** RFC 4180 CSV, including BOM, quoted commas/newlines, CRLF and escaped quotes. */
export function parseCatalogCsv(source: string): { row: number; values: Partial<Record<CatalogCsvColumn, string>> }[] {
  const input = source.replace(/^\uFEFF/, "");
  const rows: { row: number; cells: string[] }[] = [];
  let cells: string[] = [], field = "", quoted = false, closed = false, line = 1, startLine = 1;
  const fail = (message: string): never => { throw new Error(`Row ${line}: ${message}`); };
  const endField = () => { cells.push(field); field = ""; closed = false; };
  const endRow = () => {
    endField();
    if (cells.some((cell) => cell.trim() !== "")) rows.push({ row: startLine, cells });
    if (rows.length > 10_001) fail("maximum 10,000 data rows per import.");
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
  const header = rows.shift()?.cells.map((cell) => cell.trim().toLowerCase());
  if (!header) throw new Error("The CSV file is empty. Download the template to get started.");
  if (new Set(header).size !== header.length) throw new Error("CSV headers must not be duplicated.");
  for (const name of header) {
    if (!(CATALOG_CSV_COLUMNS as readonly string[]).includes(name)) throw new Error(`Unknown column: ${name}. Use the CSV template headers.`);
  }
  for (const name of ["category", "name", "price", "gst_rate"]) {
    if (!header.includes(name)) throw new Error(`Missing required column: ${name}.`);
  }
  if (!rows.length) throw new Error("The CSV has no items to import.");
  return rows.map(({ row, cells: values }) => {
    if (values.length !== header.length) throw new Error(`Row ${row}: expected ${header.length} columns, found ${values.length}.`);
    return { row, values: Object.fromEntries(header.map((name, i) => {
      const value = values[i]!;
      return [name, value.startsWith("'") && unsafeCell.test(value.slice(1)) ? value.slice(1) : value];
    })) };
  });
}
