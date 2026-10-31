import { describe, expect, it } from "vitest";
import { match } from "./router";

describe("match", () => {
  it("captures decoded path values", () => {
    expect(match("/customers/:id", "/customers/abc")).toEqual({ id: "abc" });
    expect(match("/customers/:id", "/customers/a%20b/")).toEqual({ id: "a b" });
    expect(match("/customers/:id", "/orders/abc")).toBeNull();
  });

  it("treats a malformed escape as no match, not a crash", () => {
    expect(match("/customers/:id", "/customers/%E0%A4%A")).toBeNull();
  });
});
