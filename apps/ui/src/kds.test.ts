import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { isKdsOff } from "./kds";

describe("isKdsOff", () => {
  it("recognises only the server's turned-off Kitchen Display refusal", () => {
    expect(isKdsOff(new ApiError(403, "Kitchen Display is turned off", "kds_off"))).toBe(true);
    expect(isKdsOff(new ApiError(403, "forbidden"))).toBe(false);
    expect(isKdsOff(new ApiError(500, "x", "kds_off"))).toBe(false);
    expect(isKdsOff(new Error("kds_off"))).toBe(false);
  });
});
