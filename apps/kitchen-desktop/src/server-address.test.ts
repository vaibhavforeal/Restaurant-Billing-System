import { describe, expect, it } from "vitest";
import { kitchenAddress } from "./server-address.js";
describe("Kitchen POS addresses", () => {
  it("accepts LAN addresses, demo ports and secure kitchen links", () => {
    expect(kitchenAddress("192.168.1.20")).toBe("http://192.168.1.20:4100/kitchen/");
    expect(kitchenAddress(" http://127.0.0.1:4110 ")).toBe("http://127.0.0.1:4110/kitchen/");
    expect(kitchenAddress("https://pos.local:4443/kitchen/")).toBe("https://pos.local:4443/kitchen/");
  });
  it.each(["file:///c:/secret", "ftp://pos.local", "http://user:pass@pos.local", "http://pos.local/settings", "http://pos.local/?token=secret", "http://pos.local/#secret", "", "http://pos.local\\settings"])("rejects invalid or credential-bearing address %s", value => {
    expect(() => kitchenAddress(value)).toThrow();
  });
});
