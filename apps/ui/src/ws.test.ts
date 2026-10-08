import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  emit(event: string, data: unknown = {}) { this.onmessage?.({ data: JSON.stringify({ event, data }) }); }
  drop(code = 1006) { this.closed = true; this.onclose?.({ code }); }
}

const store = new Map<string, string>();
let connectWs: typeof import("./ws").connectWs;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  store.clear();
  store.set("forkflow.token", "t1");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "pos.local", pathname: "/" });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal("Event", class { constructor(public type: string) {} });
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  vi.resetModules();
  ({ connectWs } = await import("./ws"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const handlers = () => ({ onEvent: vi.fn(), onStatus: vi.fn(), onAuthFail: vi.fn() });

describe("shared websocket", () => {
  it("serves every subscriber from one authenticated socket", () => {
    const a = handlers(), b = handlers();
    connectWs(a); connectWs(b);
    expect(FakeSocket.all).toHaveLength(1);
    const socket = FakeSocket.all[0]!;
    socket.open();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "auth", token: "t1" });
    socket.emit("auth.ok");
    socket.emit("order.updated", { id: 1 });
    for (const h of [a, b]) {
      expect(h.onStatus).toHaveBeenCalledWith(true);
      expect(h.onEvent).toHaveBeenCalledExactlyOnceWith("order.updated", { id: 1 });
    }
  });

  it("tells a late subscriber the socket is already connected", async () => {
    connectWs(handlers());
    FakeSocket.all[0]!.open(); FakeSocket.all[0]!.emit("auth.ok");
    const late = handlers();
    connectWs(late);
    await Promise.resolve();
    expect(late.onStatus).toHaveBeenCalledExactlyOnceWith(true);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("stops delivering to a disposed subscriber and closes only after the last one leaves", () => {
    const a = handlers(), b = handlers();
    const stopA = connectWs(a), stopB = connectWs(b);
    const socket = FakeSocket.all[0]!;
    socket.open(); socket.emit("auth.ok");
    stopA();
    socket.emit("table.changed");
    expect(a.onEvent).not.toHaveBeenCalled();
    expect(b.onEvent).toHaveBeenCalledOnce();
    stopB();
    expect(socket.closed).toBe(false); // a screen swap unsubscribes and resubscribes within one commit
    vi.advanceTimersByTime(2000);
    expect(socket.closed).toBe(true);
  });

  it("reuses the socket when a new subscriber arrives during the close grace period", () => {
    const stop = connectWs(handlers());
    stop();
    connectWs(handlers());
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]!.closed).toBe(false);
  });

  it("opens a fresh socket when the signed-in token has changed", () => {
    connectWs(handlers());
    store.set("forkflow.token", "t2");
    connectWs(handlers());
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[0]!.closed).toBe(true);
    FakeSocket.all[1]!.open();
    expect(JSON.parse(FakeSocket.all[1]!.sent[0]!)).toMatchObject({ token: "t2" });
  });

  it("reconnects once for everyone after a drop", () => {
    const a = handlers(), b = handlers();
    connectWs(a); connectWs(b);
    FakeSocket.all[0]!.open(); FakeSocket.all[0]!.emit("auth.ok");
    FakeSocket.all[0]!.drop();
    expect(a.onStatus).toHaveBeenLastCalledWith(false);
    expect(b.onStatus).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("reports an auth failure to every subscriber and does not reconnect", () => {
    const a = handlers(), b = handlers();
    connectWs(a); connectWs(b);
    FakeSocket.all[0]!.drop(4401);
    expect(a.onAuthFail).toHaveBeenCalledOnce();
    expect(b.onAuthFail).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(20000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("keeps delivering to other subscribers when one handler throws", () => {
    const bad = { ...handlers(), onEvent: vi.fn(() => { throw new Error("boom"); }) }, good = handlers();
    connectWs(bad); connectWs(good);
    FakeSocket.all[0]!.emit("order.updated");
    expect(good.onEvent).toHaveBeenCalledOnce();
  });

  it("raises license.changed once, not once per subscriber", () => {
    connectWs(handlers()); connectWs(handlers()); connectWs(handlers());
    FakeSocket.all[0]!.emit("license.changed");
    expect(window.dispatchEvent).toHaveBeenCalledOnce();
  });
});
