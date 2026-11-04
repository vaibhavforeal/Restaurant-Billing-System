import { describe, expect, it } from "vitest";
import { withPopularFirst } from "./popular-items";

const item = (id: string, categoryId = "c") => ({ id, categoryId });

describe("withPopularFirst", () => {
  it("moves popular products to the front and keeps the rest in order", () => {
    const list = [item("a"), item("b"), item("c"), item("d")];
    expect(withPopularFirst(list, ["c"]).map((p) => p.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("keeps menu order among popular products, so All items lists each category's best-seller first", () => {
    const list = [item("a", "x"), item("b", "y"), item("c", "x"), item("d", "y")];
    expect(withPopularFirst(list, ["d", "c"]).map((p) => p.id)).toEqual(["c", "d", "a", "b"]);
  });

  it("leaves the list alone when nothing is popular, and ignores unknown ids", () => {
    const list = [item("a"), item("b")];
    expect(withPopularFirst(list, [])).toEqual(list);
    expect(withPopularFirst(list, ["zz"]).map((p) => p.id)).toEqual(["a", "b"]);
  });
});
