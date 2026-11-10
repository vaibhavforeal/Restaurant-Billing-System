import { describe, expect, it } from "vitest";
import type { DeviceKind, DeviceMe } from "@masalapos/domain";
import { codeFromLocation, countdown, gateDecision, homeForKind } from "./join-code";

const me = (joined: boolean, kind: DeviceKind | null = null, mainPc = false): DeviceMe => ({ joined, kind, mainPc });

describe("joining a device", () => {
  it("reads the code from a join link", () => {
    expect(codeFromLocation({ pathname: "/join", hash: "#k7m2qp" })).toBe("K7M2QP");
    expect(codeFromLocation({ pathname: "/join/", hash: "#K7M2QP" })).toBe("K7M2QP");
    expect(codeFromLocation({ pathname: "/join", hash: "#nope" })).toBe("");
    expect(codeFromLocation({ pathname: "/join", hash: "" })).toBe("");
    expect(codeFromLocation({ pathname: "/", hash: "#K7M2QP" })).toBe("");
  });
  it("sends each kind of device to its screen", () => {
    expect([homeForKind("counter"), homeForKind("kitchen"), homeForKind("captain")]).toEqual(["/", "/kitchen/", "/captain/"]);
  });
  it("decides between the app and the join screen", () => {
    expect(gateDecision(me(false), false, "/")).toEqual({ show: "join", me: me(false) });
    expect(gateDecision(me(false), false, "/kitchen/")).toEqual({ show: "join", me: me(false) });
    expect(gateDecision(me(false), true, "/")).toEqual({ show: "app" });
    expect(gateDecision(me(true, "counter"), false, "/")).toEqual({ show: "app" });
    expect(gateDecision(me(true, "counter"), false, "/kitchen/")).toEqual({ show: "app" });
    expect(gateDecision(me(true, "kitchen"), false, "/join")).toEqual({ redirect: "/kitchen/" });
    expect(gateDecision(me(true, "captain"), false, "/join/")).toEqual({ redirect: "/captain/" });
    expect(gateDecision("unreachable", "unreachable", "/captain/")).toEqual({ show: "app" });
    expect(gateDecision("unreachable", false, "/")).toEqual({ show: "app" });
    expect(gateDecision(me(false), "unreachable", "/")).toEqual({ show: "app" });
  });
  it("counts down in minutes and seconds", () => {
    expect([countdown(600_000), countdown(545_000), countdown(9_400), countdown(0), countdown(-5)]).toEqual(["10:00", "9:05", "0:10", "0:00", "0:00"]);
  });
});
