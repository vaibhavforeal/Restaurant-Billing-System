import { describe, expect, it } from "vitest";
import { startRoute } from "./start-route";

describe("startRoute", () => {
  it("sends a cafe without an active owner to Set owner PIN", () => {
    expect(startRoute({ hasCafe: true, hasOwner: false, signedIn: false })).toBe("/set-owner");
  });
  it.each([
    [{ hasCafe: false, hasOwner: false, signedIn: false }, "/first-run"],
    [{ hasCafe: false, hasOwner: true, signedIn: true }, "/first-run"],
    [{ hasCafe: true, hasOwner: false, signedIn: true }, "/set-owner"],
    [{ hasCafe: true, hasOwner: true, signedIn: false }, "/lock"],
    [{ hasCafe: true, hasOwner: true, signedIn: true }, "/bill"],
  ] as const)("%j goes to %s", (state, route) => {
    expect(startRoute(state)).toBe(route);
  });
});
