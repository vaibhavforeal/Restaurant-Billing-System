import { describe, expect, it } from "vitest";
import { redactUrl } from "./log-redact.js";

describe("redactUrl", () => {
  it("redacts token query parameter", () => {
    const url = "/api/ws?token=abc123xyz";
    const result = redactUrl(url);
    expect(result).toBe("/api/ws?token=<redacted>");
  });

  it("leaves URL unchanged when there is no token parameter", () => {
    const url = "/api/orders?status=open";
    const result = redactUrl(url);
    expect(result).toBe("/api/orders?status=open");
  });

  it("preserves other query parameters", () => {
    const url = "/api/ws?foo=bar&token=secret&baz=qux";
    const result = redactUrl(url);
    expect(result).toBe("/api/ws?foo=bar&token=<redacted>&baz=qux");
  });

  it("handles absolute URLs", () => {
    const url = "http://localhost:4100/api/ws?token=secret";
    const result = redactUrl(url);
    expect(result).toBe("http://localhost:4100/api/ws?token=<redacted>");
  });

  it("returns the original URL unchanged for malformed URLs", () => {
    const url = "not-a-valid-url";
    const result = redactUrl(url);
    expect(result).toBe("not-a-valid-url");
  });
});
