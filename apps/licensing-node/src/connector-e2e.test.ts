// Live support end to end over real sockets: the Node host with its hub on a port, a real counter (POS server) pointed at it, the
// restaurant's chat over HTTP, support staff and the sharing window over WebSockets. Only Electron's screen capture is left out:
// the desktop shell is a recorder of what the server asks it to do.
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import worker from "../../licensing-worker/src/index.js";
import { authorizeLive, LIVE_PATHS } from "../../licensing-worker/src/live/authorize.js";
import { SupportHub } from "../../licensing-worker/src/live/hub.js";
import type { ChatDetail, ChatSummary, RemoteSession, VisitorChat } from "../../licensing-worker/src/portal/api-types.js";
import { seedCustomer, seedOrder } from "../../licensing-worker/src/testing/fixtures.js";
import { keyPair, testEnv } from "../../licensing-worker/src/testing/harness.js";
import { client, PASSWORD, seedStaff } from "../../licensing-worker/src/testing/portal.js";
import { TEST_SECRET } from "../../licensing-worker/src/testing/secret.js";
import { MIGRATIONS, migrate, openDb, type RemoteToDesktop } from "../../../packages/domain/src/index.js";
import { buildServer } from "../../server/src/server.js";
import { createApp } from "./app.js";

const keys = keyPair();
const COUNTER = "88888888-8888-4888-8888-888888888888";
const DEVICE = "e".repeat(64);
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function waitFor<T>(check: () => T | Promise<T>, what: string, ms = 5_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A socket that keeps every message it receives. */
async function socket(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const got: Array<Record<string, unknown>> = [];
  ws.on("message", (data) => got.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("unexpected-response", (_q, res) => reject(new Error(`refused ${res.statusCode}`))); });
  cleanups.push(() => ws.terminate());
  return { ws, got, of: (type: string) => got.filter((m) => m["type"] === type), send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe("connector over real sockets", () => {
  it("keeps capture behind consent and carries chat, signalling and counter audit events", async () => {
    const env = testEnv(keys.privatePem);
    const liveDeps = { db: env.DB, now: Date.now, uuid: () => crypto.randomUUID() };
    const hub = new SupportHub(env, liveDeps, () => {});
    env.LIVE = hub;
    await hub.start(60_000);
    cleanups.push(() => hub.stop());
    const host = createApp(worker, env, { live: { hub, paths: LIVE_PATHS, authorize: (request) => authorizeLive(request, env, liveDeps) } }).listen(0, "127.0.0.1");
    await new Promise((resolve) => host.once("listening", resolve));
    cleanups.push(() => new Promise((resolve) => host.close(resolve)));
    const origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;

    // MasalaPOS's side: a customer with a paid order, and a support person signed in over real HTTP.
    const customer = await seedCustomer(env.DB, { name: "Spice Route" });
    const order = await seedOrder(env.DB, customer);
    const neha = await seedStaff(env, "support", { name: "Neha Sharma" });
    const login = await fetch(`${origin}/portal/api/login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email: neha.email, password: PASSWORD }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const support = client(env, cookie);

    // The restaurant's counter, activated with its setup card, talking to the host for real.
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    const toDesktop: RemoteToDesktop[] = [];
    const fromDesktop: Array<(m: unknown) => void> = [];
    const counter = buildServer({ db, appVersion: "0.7.0", licensing: { publicKey: keys.publicPem, installationId: COUNTER, installationSecret: TEST_SECRET, serviceUrl: origin },
      updateBridge: { send: (m) => { if (m.type.startsWith("remote-") || m.type === "connector-open") toDesktop.push(m as RemoteToDesktop); }, onMessage: (l) => { fromDesktop.push(l); } } });
    cleanups.push(async () => { await counter.close(); db.close(); });
    const activated = await counter.inject({ method: "POST", url: "/api/setup/activate", headers: { "x-masalapos-device": DEVICE }, payload: { customerId: customer.code, orderId: order.code } });
    expect(activated.statusCode, activated.body).toBe(200);
    const setup = await counter.inject({ method: "POST", url: "/api/setup", headers: { "x-masalapos-device": DEVICE }, payload: { restaurantName: "Spice Route", address: "12 MG Road", city: "Bengaluru", stateCode: "29", pincode: "560001", phone: "9845012345", adminName: "Meera", username: "admin", password: "admin-password", pin: "1234" } });
    const pos = { authorization: `Bearer ${setup.json().token}`, "x-masalapos-device": DEVICE };
    await counter.ready();
    await waitFor(() => hub.counterOnline(COUNTER), "the counter's live connection");

    // Get support: a one-time link, opened in the browser, becomes the restaurant's chat.
    const { url } = (await counter.inject({ method: "POST", url: "/api/support/link", headers: pos })).json() as { url: string };
    expect(url.startsWith(`${origin}/support/start?t=`)).toBe(true);
    const opened = await fetch(url, { redirect: "manual" });
    expect(opened.status).toBe(303);
    const visitorCookie = opened.headers.get("set-cookie")!.split(";")[0]!;
    const page = await socket(`${origin.replace("http", "ws")}/support/live`, { cookie: visitorCookie, origin });
    const staff = await socket(`${origin.replace("http", "ws")}/portal/api/live`, { cookie, origin });
    await waitFor(() => staff.of("hello")[0], "hello");
    expect(staff.of("hello")[0]!["counters"]).toEqual([COUNTER]);

    const sent = await fetch(`${origin}/support/api/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: visitorCookie, origin },
      body: JSON.stringify({ body: "The KOT printer stopped", name: "Meera" }) });
    expect(sent.status).toBe(201);
    const pushed = await waitFor(() => staff.of("chat.updated")[0], "the chat reaching support") as { chat: ChatSummary };
    expect(pushed.chat).toMatchObject({ status: "waiting", customer: { name: "Spice Route" }, installation: { id: COUNTER } });
    await support.ok("POST", `/chats/${pushed.chat.id}/messages`, { body: "Hi Meera, let me take a look." });
    await waitFor(() => page.of("visitor.updated").find((e) => (e["messages"] as Array<{ name: string }>).some((m) => m.name === "Neha")), "the reply reaching the restaurant");
    const { chat } = await support.ok<{ chat: ChatDetail }>("GET", `/chats/${pushed.chat.id}`);
    expect(chat.counterOnline).toBe(true);

    // Connector request reaches the counter, but opening the download does not grant access.
    env.CONNECTOR = { enabled: true, manifest: async () => ({version: "0.7.0",sha256:"a".repeat(64),size:1,url:"https://test.cloudfront.net/runtime/connector-0.7.0.zip",signature:"test"}), stubUrl: async (_v,filename) => `https://test.cloudfront.net/stub?name=${encodeURIComponent(filename)}` };
    const invitationResponse = await fetch(`${origin}/portal/api/connector`, {method:"POST", headers:{"content-type":"application/json",origin,cookie},body:JSON.stringify({chatId:chat.id,reason:"Check the KOT printer settings",mode:"control"})});
    expect(invitationResponse.status).toBe(201);
    const invitation = await invitationResponse.json() as {session:RemoteSession;url:string;code:string};
    const session = invitation.session;
    const pending = await waitFor(async () => { const s = (await counter.inject({url:"/api/support/status",headers:pos})).json(); return s.pending ? s : null; },"connector invitation at the counter");
    expect(pending.pending.connectorUrl).toBe(invitation.url);
    expect((await counter.inject({method:"POST",url:"/api/support/remote/answer",headers:pos,payload:{sessionId:session.id,decision:"control"}})).statusCode).toBe(200);
    await waitFor(()=>toDesktop.find((m)=>m.type === "connector-open"),"connector download opened");
    expect(toDesktop.some((m)=>m.type === "remote-start")).toBe(false);
    const redeemResponse = await fetch(`${origin}/v1/connector/redeem`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:invitation.code})});
    expect(redeemResponse.status).toBe(200);
    const redeemed = await redeemResponse.json() as {token:string};
    expect((await support.ok<{session:RemoteSession}>("GET",`/remote-sessions/${session.id}`)).session.status).toBe("requested");
    const consentResponse = await fetch(`${origin}/v1/connector/consent`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:redeemed.token,mode:"control",approvedBy:"Meera",elevated:true,adminPrompts:false})});
    expect(consentResponse.status).toBe(200);
    const allowed = await consentResponse.json() as {token:string;agentPath:string};
    staff.send({type:"remote.watch",sessionId:session.id});
    const agent = await socket(`${origin.replace("http","ws")}${allowed.agentPath}?t=${allowed.token}`,{});
    await waitFor(()=>agent.of("remote.peer")[0],"viewer connected to connector");
    agent.send({type:"remote.signal",data:{kind:"offer",sdp:"v=0 connector-offer"}});
    await waitFor(()=>staff.of("remote.signal")[0],"connector offer reaching viewer");
    staff.send({type:"remote.signal",sessionId:session.id,data:{kind:"answer",sdp:"v=0 answer"}});
    await waitFor(()=>agent.of("remote.signal")[0],"viewer answer reaching connector");
    agent.send({type:"chat.send",body:"I opened Device Manager"});
    await waitFor(()=>staff.of("chat.updated").find((e)=>(e["messages"] as Array<{body:string}>).some((m)=>m.body === "I opened Device Manager")),"connector message reaching support");
    await support.ok("POST",`/chats/${chat.id}/messages`,{body:"Thanks, I can see it"});
    await waitFor(()=>agent.of("chat.updated").find((e)=>(e["messages"] as Array<{body:string}>).some((m)=>m.body === "Thanks, I can see it")),"support reply reaching connector");
    const before = (await support.ok<{chat:ChatDetail}>("GET",`/chats/${chat.id}`)).chat.messages.length;
    agent.send({type:"chat.send",chatId:crypto.randomUUID(),body:"Forged destination"});
    await new Promise((resolve)=>setTimeout(resolve,30));
    expect((await support.ok<{chat:ChatDetail}>("GET",`/chats/${chat.id}`)).chat.messages.length).toBe(before);
    agent.ws.close();
    await waitFor(async ()=>(await support.ok<{session:RemoteSession}>("GET",`/remote-sessions/${session.id}`)).session.status === "ended","connector stopped");
    await waitFor(async ()=> (await counter.inject({url:"/api/support/remote-log",headers:pos})).json().entries.some((e:{event:string})=>e.event === "ended"),"counter audit synchronized");
    const log = (await counter.inject({url:"/api/support/remote-log",headers:pos})).json().entries as Array<{event:string}>;
    expect(log.map((e)=>e.event).reverse()).toEqual(["requested","allowed","started","ended"]);
    expect((await support.ok<{chat:ChatDetail}>("GET",`/chats/${chat.id}`)).chat.messages.some((m)=>m.body.includes("Remote session ended"))).toBe(true);
  },20_000);
});
