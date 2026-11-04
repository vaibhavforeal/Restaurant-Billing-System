import { describe, expect, it } from "vitest";
import { adminProblem } from "./admin-account";

const OK = { username: "Meera", password: "spice-route-1", confirm: "spice-route-1", pin: "2468" };

describe("adminProblem", () => {
  it("accepts a sound admin, whatever the username's case", () => {
    expect(adminProblem(OK)).toBeNull();
  });
  it("names the first thing to fix", () => {
    expect(adminProblem({ ...OK, username: "me" })).toMatch(/username/);
    expect(adminProblem({ ...OK, password: "short", confirm: "short" })).toMatch(/at least 8/);
    expect(adminProblem({ ...OK, password: "        ", confirm: "        " })).toMatch(/only spaces/);
    expect(adminProblem({ ...OK, confirm: "spice-route-2" })).toMatch(/do not match/);
    expect(adminProblem({ ...OK, pin: "12" })).toMatch(/approval PIN/);
  });
});
