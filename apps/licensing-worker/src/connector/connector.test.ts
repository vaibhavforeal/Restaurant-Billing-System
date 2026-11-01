import { describe, expect, it } from "vitest";
import { SupportHub } from "../live/hub.js";
import { authorizeLive } from "../live/authorize.js";
import { as } from "../testing/portal.js";
import { activation, keyPair, ORIGIN, send, testEnv, withSecret } from "../testing/harness.js";
import { seedCustomer, seedOrder } from "../testing/fixtures.js";
import { sweepRemote } from "../support/remote.js";
import { fileD1, migrate } from "../../../licensing-node/src/sqlite-d1.js";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const keys = keyPair();
async function setup() {
  const env = testEnv(keys.privatePem, { CONNECTOR: { enabled: true,
    manifest: async () => ({ version: "0.7.0", sha256: "a".repeat(64), size: 100, signature: "test", url: "https://cdn.test/runtime/connector-0.7.0.zip" }),
    stubUrl: async (_v, name) => `https://cdn.test/stub?filename=${encodeURIComponent(name)}` } });
  env.LIVE = new SupportHub(env, { db: env.DB, now: Date.now, uuid: crypto.randomUUID });
  const customer = await seedCustomer(env.DB), staff = await as(env, "support");
  const invite = async (mode = "control") => staff.ok<{ url: string; code: string; sessionId: string; chatId: string }>("POST", "/connector", { customerId: customer.id, reason: "Printer setup", mode });
  return { env, staff, invite };
}
describe("connector invitations", () => {
  it("supports customers without installations; GET does not consume, redemption and consent are single-use", async () => {
    const { env, staff, invite } = await setup();
    const invitation = await invite(), url = new URL(invitation.url), token = url.searchParams.get("t");
    const stored = JSON.stringify(await env.DB.prepare("SELECT * FROM support_chat_messages WHERE chat_id = ?").bind(invitation.chatId).all());
    expect(stored).not.toContain(token); expect(stored).not.toContain(invitation.code);

    expect((await send(env, "GET", url.pathname + url.search)).status).toBe(302);
    expect((await send(env, "GET", url.pathname + url.search)).status).toBe(302);
    const raced = await Promise.all([send(env, "POST", "/v1/connector/redeem", { token }), send(env, "POST", "/v1/connector/redeem", { code: invitation.code })]);
    expect(raced.map((r) => r.status).sort()).toEqual([200,403]);
    const redeemed = await raced.find((r) => r.status === 200)!.json() as { token: string; session: { installation: unknown } };
    expect(redeemed.session.installation).toBeNull();
    expect((await send(env, "GET", url.pathname + url.search)).status).toBe(403);
    const approval = { token: redeemed.token, mode: "view", approvedBy: "Meera", elevated: true, adminPrompts: false };
    const responses = await Promise.all([send(env, "POST", "/v1/connector/consent", approval), send(env, "POST", "/v1/connector/consent", approval)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200,403]);
    const allowed = await responses.find((r) => r.status === 200)!.json() as { token: string; session: { mode: string; origin: string } };
    expect(allowed.session).toMatchObject({ mode: "view", origin: "connector" });
    const deps = { db: env.DB, now: Date.now, uuid: crypto.randomUUID };
    expect(await authorizeLive(new Request(`${ORIGIN}/v1/remote/agent?t=${allowed.token}`), env, deps)).toBeNull();
    const request = new Request(`${ORIGIN}/v1/connector/live?t=${allowed.token}`);
    expect(await authorizeLive(request, env, deps)).toMatchObject({ kind: "connector", chatId: invitation.chatId, installationId: null });
    expect(await authorizeLive(request, env, deps)).toBeNull();
    expect((await staff.ok<{ chat: { installation: unknown } }>("GET", `/chats/${invitation.chatId}`)).chat.installation).toBeNull();
  });
  it("refuses over-grants, impossible prompt consent, expired tokens and disabled distribution", async () => {
    const { env, invite } = await setup();
    const invitation = await invite("view");
    const redeemed = await (await send(env, "POST", "/v1/connector/redeem", { code: invitation.code.toLowerCase() })).json() as { token: string };
    const consent = { token: redeemed.token, mode: "control", elevated: true, approvedBy: "Meera" };
    expect((await send(env, "POST", "/v1/connector/consent", consent)).status).toBe(400);
    expect((await send(env, "POST", "/v1/connector/consent", { ...consent, mode: "view", elevated: false, adminPrompts: true })).status).toBe(400);
    const denied = await (await send(env, "POST", "/v1/connector/consent", { ...consent, mode: "deny" })).json() as { token?: string; session: { status: string } };
    expect(denied.token).toBeUndefined(); expect(denied.session.status).toBe("denied");
    const another = await invite();
    await env.DB.prepare("UPDATE connector_tokens SET expires_at = 1 WHERE session_id = ?").bind(another.sessionId).run();
    expect((await send(env, "POST", "/v1/connector/redeem", { code: another.code })).status).toBe(403);
    env.CONNECTOR!.enabled = false;
    expect((await send(env, "GET", "/support/connector-runtime/latest.json")).status).toBe(503);
  });
  it("uses connector expiry rather than the in-app timeout and fails closed on limiter failure", async () => {
    const { env, invite } = await setup(), invitation = await invite();
    await env.DB.prepare("UPDATE remote_sessions SET requested_at = 1 WHERE id = ?").bind(invitation.sessionId).run();
    await sweepRemote({ db: env.DB, live: env.LIVE, now: Date.now, env });
    expect(await env.DB.prepare("SELECT status FROM remote_sessions WHERE id = ?").bind(invitation.sessionId).first()).toEqual({ status: "requested" });
    env.CONNECTOR_LIMITER = { limit: async () => { throw new Error("offline"); } };
    expect((await send(env, "POST", "/v1/connector/redeem", { code: invitation.code })).status).toBe(429);
    await env.DB.prepare("UPDATE remote_sessions SET expires_at = 1 WHERE id = ?").bind(invitation.sessionId).run();
    await sweepRemote({ db: env.DB, live: env.LIVE, now: Date.now, env });
    expect(await env.DB.prepare("SELECT status FROM remote_sessions WHERE id = ?").bind(invitation.sessionId).first()).toEqual({ status: "expired" });
  });
});

it("migrates populated phase-one support tables transactionally without losing references", async () => {
  const dir = mkdtempSync(join(tmpdir(), "connector-migration-"));
  const source = fileURLToPath(new URL("../../migrations/", import.meta.url));
  for (const name of readdirSync(source).filter((f) => f.endsWith(".sql") && f < "0009")) cpSync(join(source,name), join(dir,name));
  const { db, d1 } = fileD1(":memory:", dir);
  try {
    const env = testEnv(keys.privatePem, { DB: d1 });
    const customer = await seedCustomer(d1), order = await seedOrder(d1, customer), staff = await as(env,"support");
    const installation = crypto.randomUUID();
    expect((await send(env,"POST","/v1/enroll", { activation: activation(installation, await keys.fingerprint()), customerId: customer.code, orderId: order.code },withSecret())).status).toBe(200);
    const chat = crypto.randomUUID(), session = crypto.randomUUID();
    db.prepare("INSERT INTO support_chats (id,number,customer_id,installation_id,created_at,last_message_at) VALUES (?,1001,?,?,1,1)").run(chat,customer.id,installation);
    db.prepare("INSERT INTO support_chat_messages (chat_id,author_type,body,created_at) VALUES (?,'customer','Existing conversation',1)").run(chat);
    db.prepare("INSERT INTO remote_sessions (id,installation_id,customer_id,chat_id,requested_by,reason,mode_requested,requested_at) VALUES (?,?,?,?,?,'Printer','view',1)").run(session,installation,customer.id,chat,staff.staff.id);
    cpSync(join(source,"0009_connector.sql"), join(dir,"0009_connector.sql"));
    expect(migrate(db,dir)).toEqual(["0009_connector.sql"]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys",{simple:true})).toBe(1);
    expect(db.prepare("SELECT body FROM support_chat_messages WHERE chat_id = ?").get(chat)).toEqual({body:"Existing conversation"});
    expect(db.prepare("SELECT origin,chat_id FROM remote_sessions WHERE id = ?").get(session)).toEqual({origin:"in_app",chat_id:chat});
    expect(migrate(db,dir)).toEqual([]);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});
