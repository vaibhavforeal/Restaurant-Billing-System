import { describe, expect, it } from "vitest";
import { uuid } from "./uuid";

describe("uuid", () => {
  it("produces RFC 4122 v4 format", () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("does not repeat", () => {
    expect(new Set(Array.from({ length: 1000 }, uuid)).size).toBe(1000);
  });
});
