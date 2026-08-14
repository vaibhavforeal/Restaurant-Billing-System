import { afterEach, describe, expect, it } from "vitest";
import { auth, freshApp, setupAdmin } from "./test-helpers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

describe("WebSocket", () => {
  it("connects with a valid token and receives broadcasts", async () => {
    app = freshApp();
    await app.ready();
    const admin = await setupAdmin(app);

    const ws = await app.injectWS("/api/ws?token=" + admin.token);
    const messages: unknown[] = [];
    ws.on("message", (raw: Buffer) => {
      messages.push(JSON.parse(raw.toString()));
    });

    try {
      app.broadcast("test.event", { x: 1 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ event: "test.event", data: { x: 1 } });
    } finally {
      ws.terminate();
    }
  });

  it("closes with code 4401 when the token is missing", async () => {
    app = freshApp();
    await app.ready();
    const ws = await app.injectWS("/api/ws");

    try {
      const result = await new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on("close", (code: number, reason: Buffer) => {
          resolve({ code, reason: reason.toString() });
        });
      });
      expect(result.code).toBe(4401);
      expect(result.reason).toBe("unauthenticated");
    } finally {
      ws.terminate();
    }
  });

  it("closes with code 4401 when the token is garbage", async () => {
    app = freshApp();
    await app.ready();
    const ws = await app.injectWS("/api/ws?token=garbage");

    try {
      const result = await new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on("close", (code: number, reason: Buffer) => {
          resolve({ code, reason: reason.toString() });
        });
      });
      expect(result.code).toBe(4401);
      expect(result.reason).toBe("unauthenticated");
    } finally {
      ws.terminate();
    }
  });
});
