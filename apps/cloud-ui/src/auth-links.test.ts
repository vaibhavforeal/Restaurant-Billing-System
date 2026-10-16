import { expect, it } from "vitest";
import { accountActionFromUrl } from "./auth-links";
it("recognizes recovery and invitation links independently of an existing session", () => {
  expect(accountActionFromUrl("https://owner.example/reset?token=one-use")).toEqual({ mode: "reset", token: "one-use" });
  expect(accountActionFromUrl("https://owner.example/#invite=one-use")).toEqual({ mode: "invite", token: "one-use" });
  expect(accountActionFromUrl("https://owner.example/?reset=one-use")).toEqual({ mode: "reset", token: "one-use" });
  expect(accountActionFromUrl("https://owner.example/")).toEqual({ mode: "login", token: "" });
});
