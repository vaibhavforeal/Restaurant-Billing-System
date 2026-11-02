import { describe, expect, it } from "vitest";
import { guestRateLimiter } from "./guest-rate.js";

describe("guest rate limiter", () => {
  it("allows `limit` calls a minute per IP and action, then resets", () => {
    let now = 0;
    const rate = guestRateLimiter(() => now);
    for (let i = 0; i < 3; i++) rate({ ip: "10.0.0.2" }, "read", 3);
    expect(() => rate({ ip: "10.0.0.2" }, "read", 3)).toThrow("Please wait a minute");
    rate({ ip: "10.0.0.2" }, "submit", 3); // another action has its own count
    rate({ ip: "10.0.0.3" }, "read", 3); // and so does another IP
    now = 60_000;
    rate({ ip: "10.0.0.2" }, "read", 3);
  });

  it("keeps its table bounded: once full of live entries, new callers wait while known ones go on", () => {
    let now = 0;
    const rate = guestRateLimiter(() => now);
    for (let i = 0; i < 10_000; i++) rate({ ip: `ip-${i}` }, "read", 5);
    expect(() => rate({ ip: "newcomer" }, "read", 5)).toThrow("Please wait a minute");
    rate({ ip: "ip-0" }, "read", 5);
    now = 60_000; // every entry has lapsed, so they are dropped and the newcomer gets in
    rate({ ip: "newcomer" }, "read", 5);
  });
});
