import { describe, expect, it } from "vitest";
import { moveTablePatches } from "./table-order";

describe("moveTablePatches", () => {
  it("swaps two neighbours with distinct numbers", () => {
    expect(moveTablePatches([{ id: "a", sortOrder: 1 }, { id: "b", sortOrder: 2 }, { id: "c", sortOrder: 3 }], "b", -1))
      .toEqual([{ id: "b", sortOrder: 1 }, { id: "a", sortOrder: 2 }]);
  });
  it("renumbers tables that share a sortOrder so the move is visible", () => {
    const patches = moveTablePatches([{ id: "a", sortOrder: 0 }, { id: "b", sortOrder: 0 }, { id: "c", sortOrder: 0 }], "b", -1);
    const final = new Map([["a", 0], ["b", 0], ["c", 0]]);
    patches.forEach((p) => final.set(p.id, p.sortOrder));
    expect([...final].sort((x, y) => x[1] - y[1]).map(([id]) => id)).toEqual(["b", "a", "c"]);
    expect(new Set(final.values()).size).toBe(3);
  });
  it("does nothing at the ends", () => {
    expect(moveTablePatches([{ id: "a", sortOrder: 1 }], "a", -1)).toEqual([]);
  });
});
