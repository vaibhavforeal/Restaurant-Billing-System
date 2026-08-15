import { afterEach, describe, expect, it } from "vitest";
import { freshApp, setupAdmin } from "./test-helpers.js";
import { loadOrderJson } from "./mappers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

describe("mappers", () => {
  it("loadOrderJson returns null for unknown order id", async () => {
    app = freshApp();
    await setupAdmin(app);
    expect(loadOrderJson(app.db, "nonexistent-id")).toBeNull();
  });
});
