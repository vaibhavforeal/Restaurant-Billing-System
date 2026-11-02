import { parseCsv, unescapeCsvField } from "./csv.js";

/** Spreadsheet-friendly catalog exchange. Prices in this format are rupees. */
export const CATALOG_CSV_LIMIT = 5 * 1024 * 1024;
export const CATALOG_CSV_COLUMNS = [
  "item_id", "category", "name", "price", "gst_rate", "is_veg", "is_active",
  "is_sold_out", "description", "kot_station", "variant_id", "variant_name",
  "variant_price", "variant_active", "ac_price", "takeaway_price", "variant_ac_price", "variant_takeaway_price",
  "zomato_price", "variant_zomato_price",
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

/** The catalog import's rows, by column name, with the formula escaping of our own export undone. */
export function parseCatalogCsv(source: string): { row: number; values: Partial<Record<CatalogCsvColumn, string>> }[] {
  const rows = parseCsv(source, 10_000, "Import up to 10,000 data rows at a time.").map(({ line, cells }) => ({ row: line, cells }));
  const header = rows.shift()?.cells.map((cell) => cell.trim().toLowerCase());
  if (!header) throw new Error("The CSV file is empty. Download the template to get started.");
  if (new Set(header).size !== header.length) throw new Error("CSV headers must not be duplicated.");
  for (const name of header) {
    if (!(CATALOG_CSV_COLUMNS as readonly string[]).includes(name)) throw new Error(`Unknown column: ${name}. Use the CSV template headers.`);
  }
  for (const name of ["category", "name", "price"]) {
    if (!header.includes(name)) throw new Error(`Missing required column: ${name}.`);
  }
  if (!rows.length) throw new Error("The CSV has no items to import.");
  return rows.map(({ row, cells: values }) => {
    if (values.length !== header.length) throw new Error(`Row ${row}: expected ${header.length} columns, found ${values.length}.`);
    return { row, values: Object.fromEntries(header.map((name, i) => {
      return [name, unescapeCsvField(values[i]!)];
    })) };
  });
}
