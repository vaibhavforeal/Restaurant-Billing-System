import { describe, expect, it } from "vitest";
import { featureSummary } from "./license-features";

describe("featureSummary", () => {
  it("lists every paid feature, including the Kitchen Display", () => {
    expect(featureSummary({ recipes: true, qrOrdering: true, kds: true })).toBe("Recipe editing: included. QR ordering: included. Kitchen Display: included.");
    expect(featureSummary({ recipes: false, qrOrdering: false, kds: false })).toBe("Recipe editing: not included. QR ordering: not included. Kitchen Display: not included.");
  });
});
