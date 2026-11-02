import { describe, expect, it } from "vitest";
import { openDb } from "@masalapos/domain";
import { priorRequest } from "./client-ref.js";

describe("priorRequest", () => {
  const db = openDb(":memory:");
  db.exec("CREATE TABLE moves (id TEXT, client_ref TEXT UNIQUE, request_json TEXT)");
  db.prepare("INSERT INTO moves VALUES ('m1', 'ref-1', '{\"qty\":2}')").run();

  it("is null for a new reference", () => {
    expect(priorRequest(db, "moves", "ref-2", '{"qty":2}', "used")).toBeNull();
  });
  it("returns the earlier row, with the columns asked for, when the same request comes again", () => {
    expect(priorRequest<{ id: string }>(db, "moves", "ref-1", '{"qty":2}', "used", "id")).toEqual({ request_json: '{"qty":2}', id: "m1" });
  });
  it("refuses the same reference sent with a different request", () => {
    expect(() => priorRequest(db, "moves", "ref-1", '{"qty":3}', "Move reference already used")).toThrow("Move reference already used");
  });
});
