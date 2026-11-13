import { describe, expect, it } from "vitest";
import { guardRoute, startRoute } from "./start-route";

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

describe("guardRoute", () => {
  const ready = { hasCafe: true, hasOwner: true, signedIn: true };
  it("sends anyone not signed in from any screen but the open ones to the lock screen", () => {
    expect(guardRoute("more", { ...ready, signedIn: false })).toBe("/lock");
    expect(guardRoute("customer", { ...ready, signedIn: false })).toBe("/lock");
    expect(guardRoute("menu", { ...ready, signedIn: false })).toBe("/lock");
    expect(guardRoute("payment", { ...ready, signedIn: false })).toBe("/lock");
    for (const open of ["lock", "first-run", "set-owner", undefined]) expect(guardRoute(open, { ...ready, signedIn: false })).toBeNull();
  });
  it("sends a cafe with no owner to Set owner PIN and no cafe to first run", () => {
    expect(guardRoute("more", { ...ready, hasOwner: false })).toBe("/set-owner");
    expect(guardRoute("lock", { ...ready, hasOwner: false })).toBe("/set-owner");
    expect(guardRoute("more", { hasCafe: false, hasOwner: false, signedIn: false })).toBe("/first-run");
    expect(guardRoute("first-run", { hasCafe: false, hasOwner: false, signedIn: false })).toBeNull();
  });
  it("leaves a signed-in person where they are", () => {
    expect(guardRoute("customer", ready)).toBeNull();
    expect(guardRoute("(tabs)", ready)).toBeNull();
  });
});
