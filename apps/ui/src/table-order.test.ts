import { describe, expect, it } from "vitest";
import { movedTableOrder } from "./table-order";

describe("movedTableOrder", () => {
  const tables = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("swaps a table with its neighbour and lists every table", () => {
    expect(movedTableOrder(tables, "b", -1)).toEqual(["b", "a", "c"]);
    expect(movedTableOrder(tables, "b", 1)).toEqual(["a", "c", "b"]);
  });
  it("does nothing at the ends or for an unknown table", () => {
    expect(movedTableOrder(tables, "a", -1)).toBeNull();
    expect(movedTableOrder(tables, "c", 1)).toBeNull();
    expect(movedTableOrder(tables, "z", 1)).toBeNull();
  });
});
