import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Deps } from "./issue.js";
import type { D1Like } from "./env.js";
import { handleCreateSession, resolveSession, SESSION_TTL_MS } from "./sessions.js";
import { sha256Hex } from "./secret.js";
import { createInstallation, getInstallation, insertSessionStatement } from "./store.js";
import { memoryD1 } from "./testing/d1.js";
import { OTHER_SECRET, TEST_SECRET } from "./testing/secret.js";

const T0 = Date.UTC(2026, 9, 10, 10, 0, 0);
const installationId = "77777777-7777-4777-8777-777777777777";
const otherId = "88888888-8888-4888-8888-888888888888";

let db: D1Like;
let now: number;
let deps: Deps;
beforeEach(async () => {
  db = memoryD1();
  now = T0;
  deps = { db, signer: undefined as never, now: () => now, uuid: () => randomUUID() };
  await addInstallation(installationId, await sha256Hex(TEST_SECRET));
});

const addInstallation = (id: string, secretHash: string | null) =>
  createInstallation(db, { installationId: id, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), trialStartedAt: T0, revisionFloor: 0, createdAt: T0, secretHash });
const create = async (body: unknown = { installationId }, secret: string | null = TEST_SECRET) => {
  const res = await handleCreateSession(deps, body, secret);
  return { status: res.status, type: res.headers.get("content-type"), body: await res.json() as { session?: string; expiresAt?: number; error?: string } };
};
const sessionRows = async () => (await db.prepare("SELECT token_hash AS tokenHash, installation_id AS installationId, expires_at AS expiresAt, created_at AS createdAt FROM subscribe_sessions ORDER BY created_at, token_hash").all<{ tokenHash: string; installationId: string; expiresAt: number; createdAt: number }>()).results;

describe("POST /v1/subscribe-sessions", () => {
  it("mints a 43-char base64url token valid for 30 minutes and stores only its hash", async () => {
    const res = await create();
    expect(res.status).toBe(200);
    expect(res.type).toContain("application/json");
    expect(res.body.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.expiresAt).toBe(T0 + 30 * 60_000);
    expect(SESSION_TTL_MS).toBe(30 * 60_000);
    expect(await sessionRows()).toEqual([{ tokenHash: await sha256Hex(res.body.session!), installationId, expiresAt: T0 + SESSION_TTL_MS, createdAt: T0 }]);
    expect(JSON.stringify(await db.prepare("SELECT * FROM subscribe_sessions").all())).not.toContain(res.body.session!);
    expect(await resolveSession(db, res.body.session!, now)).toBe(installationId);
  });

  it("every session is a fresh token", async () => {
    const a = (await create()).body.session, b = (await create()).body.session;
    expect(a).not.toBe(b);
    expect(await sessionRows()).toHaveLength(2);
  });

  it("an unknown installation is 404 and writes nothing", async () => {
    const res = await create({ installationId: otherId });
    expect(res).toMatchObject({ status: 404, body: { error: "unknown_installation" } });
    expect(await sessionRows()).toEqual([]);
  });

  it("a missing, malformed or wrong secret is 401 and writes nothing", async () => {
    for (const secret of [null, "", "nope", "A".repeat(64), OTHER_SECRET]) {
      const res = await create({ installationId }, secret);
      expect(res).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    }
    expect(await sessionRows()).toEqual([]);
  });

  it("a bad body is 400", async () => {
    for (const body of [null, [], {}, { installationId: "x" }, { installationId: 5 }]) expect(await create(body)).toMatchObject({ status: 400, body: { error: "bad_request" } });
    expect(await sessionRows()).toEqual([]);
  });

  it("a NULL secret hash is claimed by the first caller, who then gets a session; a later wrong secret does not", async () => {
    await addInstallation(otherId, null);
    expect((await create({ installationId: otherId }, OTHER_SECRET)).status).toBe(200);
    expect((await getInstallation(db, otherId))?.secretHash).toBe(await sha256Hex(OTHER_SECRET));
    expect((await create({ installationId: otherId }, TEST_SECRET)).status).toBe(401);
    expect((await getInstallation(db, otherId))?.secretHash).toBe(await sha256Hex(OTHER_SECRET));
  });

  it("creating deletes only this installation's expired sessions", async () => {
    await addInstallation(otherId, await sha256Hex(OTHER_SECRET));
    await insertSessionStatement(db, { tokenHash: "old-mine", installationId, expiresAt: T0 - 1, createdAt: T0 - SESSION_TTL_MS }).run();
    await insertSessionStatement(db, { tokenHash: "edge-mine", installationId, expiresAt: T0, createdAt: T0 - SESSION_TTL_MS }).run();
    await insertSessionStatement(db, { tokenHash: "live-mine", installationId, expiresAt: T0 + 1, createdAt: T0 - 1 }).run();
    await insertSessionStatement(db, { tokenHash: "old-other", installationId: otherId, expiresAt: T0 - 1, createdAt: T0 - SESSION_TTL_MS }).run();
    expect((await create()).status).toBe(200);
    expect((await sessionRows()).map((r) => r.tokenHash).filter((h) => h.length < 20).sort()).toEqual(["live-mine", "old-other"]);
    expect(await sessionRows()).toHaveLength(3);
  });
});

describe("resolveSession", () => {
  it("resolves a live session, reusable within its lifetime", async () => {
    const { session } = (await create()).body;
    expect(await resolveSession(db, session!, now + 10 * 60_000)).toBe(installationId);
    expect(await resolveSession(db, session!, now + 29 * 60_000)).toBe(installationId);
  });

  it("treats a session as expired from its expiry instant on", async () => {
    const { session, expiresAt } = (await create()).body;
    expect(await resolveSession(db, session!, expiresAt! - 1)).toBe(installationId);
    expect(await resolveSession(db, session!, expiresAt!)).toBeNull();
    expect(await resolveSession(db, session!, expiresAt! + 1)).toBeNull();
  });

  it("malformed, empty, null and unknown tokens resolve to nothing", async () => {
    await create();
    for (const token of [null, "", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}+`, `${"a".repeat(42)}/`, " ".repeat(43), "a".repeat(43)]) expect(await resolveSession(db, token, now)).toBeNull();
  });

  it("the stored hash is not itself a usable token", async () => {
    const { session } = (await create()).body;
    expect(await resolveSession(db, await sha256Hex(session!), now)).toBeNull();
  });
});
