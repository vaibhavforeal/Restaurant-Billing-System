import { CATALOG_CSV_COLUMNS, catalogCsv } from "@forkflow/domain/catalog-csv";

/** Sample rows of the downloadable item template. gst_rate is blank so a copied row uses the restaurant default rate, not a pinned override. */
export const CATALOG_TEMPLATE_ROWS: string[][] = [
  ["", "Beverages", "Masala chai", "40.00", "", "true", "true", "false", "Freshly brewed tea", "Kitchen", "", "", "", "", "50.00", "45.00", "", "", "", ""],
  ["", "Beverages", "Masala chai", "40.00", "", "true", "true", "false", "Freshly brewed tea", "Kitchen", "", "Large", "60.00", "true", "50.00", "45.00", "70.00", "65.00", "", ""],
];

export const catalogTemplateCsv = () => catalogCsv([[...CATALOG_CSV_COLUMNS], ...CATALOG_TEMPLATE_ROWS]);
