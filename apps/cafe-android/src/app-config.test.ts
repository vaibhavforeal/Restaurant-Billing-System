import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("app.json", () => {
  // Screens read the cart store and synchronous SQLite during render. The React Compiler assumes such reads are pure
  // and caches them, which froze the cart (review finding, 2026-11-13). Keep it off unless every read is made explicit.
  it("keeps the React Compiler off", () => {
    const app = JSON.parse(readFileSync(join(__dirname, "..", "app.json"), "utf8"));
    expect(app.expo.experiments?.reactCompiler ?? false).toBe(false);
  });
});
