import { expect, it } from "vitest";
import { parseZomatoCsv, ZOMATO_CSV_COLUMNS, zomatoCsv } from "./zomato.js";

it("preserves quoted identifiers and neutralizes spreadsheet formulas on export", () => {
  const source = zomatoCsv([ZOMATO_CSV_COLUMNS.settlements, ["R1", "00001", "E1", '=HYPERLINK("x","y")', "2026-10-02", "0", "10", "0", "-10"]]);
  expect(source).toContain("'=HYPERLINK");
  expect(parseZomatoCsv(source, "settlements")[0]).toMatchObject({ order_id: "00001", settlement_reference: '=HYPERLINK("x","y")', net_paid: "-10" });
});
it("rejects duplicate headers, broken quoting and excessive row counts", () => {
  for (const csv of ['restaurant_id,restaurant_id\nR1,R2', '"a"x,b\n1,2', '"a,b\n1,2']) expect(() => parseZomatoCsv(csv, "orders")).toThrow();
  expect(() => parseZomatoCsv(zomatoCsv([ZOMATO_CSV_COLUMNS.orders, ...Array.from({ length: 1001 }, (_, i) => ["R1", String(i), "2026-10-02T12:00:00Z", "delivered", "1", "prepaid"])]), "orders")).toThrow("1,000");
});
