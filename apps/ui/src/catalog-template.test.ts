import { describe, expect, it } from "vitest";
import { CATALOG_CSV_COLUMNS } from "@forkflow/domain/catalog-csv";
import { CATALOG_TEMPLATE_ROWS } from "./catalog-template";

describe("item CSV template", () => {
  it("has a value for every column in every sample row", () => {
    for (const row of CATALOG_TEMPLATE_ROWS) expect(row).toHaveLength(CATALOG_CSV_COLUMNS.length);
  });

  it("leaves gst_rate blank so copied rows follow the restaurant default rate", () => {
    const column = CATALOG_CSV_COLUMNS.indexOf("gst_rate");
    for (const row of CATALOG_TEMPLATE_ROWS) expect(row[column]).toBe("");
  });
});
