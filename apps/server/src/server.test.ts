import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

export function testDb() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

let app: Awaited<ReturnType<typeof buildServer>>;
afterEach(async () => {
  await app?.close();
});

describe("GET /api/health", () => {
  it("returns ok", async () => {
    app = buildServer({ db: testDb() });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
