import { UPDATE_CHANNELS, isToServer, type ToDesktop, type UpdateChannel, type UpdateStatus } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";

/** The message port to the Electron shell that owns the updater. Absent when the server runs without the desktop app. */
export interface UpdateBridge {
  send(message: ToDesktop): void;
  onMessage(listener: (message: unknown) => void): void;
}

const UpdateSettings = z.object({ channel: z.enum(UPDATE_CHANNELS) });

/**
 * Settings → Updates. The shell downloads in the background; installing restarts ForkFlow on every counter, so the admin
 * starts it, and only while no order is open or waiting for payment.
 */
export function registerUpdates(app: FastifyInstance, bridge: UpdateBridge | undefined, currentVersion: string): void {
  const db = app.db;
  const manage = app.requirePermission("settings.manage");
  let status: UpdateStatus = bridge
    ? { state: "idle", currentVersion, availableVersion: null, percent: null, checkedAt: null, message: null }
    : { state: "unsupported", currentVersion, availableVersion: null, percent: null, checkedAt: null,
      message: "This server is running without the ForkFlow desktop app, which installs updates." };
  const channel = () => (db.prepare("SELECT update_channel AS c FROM settings WHERE id = 1").get() as { c: UpdateChannel }).c;
  const busyOrders = () => (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('open', 'billed')").get() as { n: number }).n;
  const state = () => ({ channel: channel(), status, openOrders: busyOrders() });

  bridge?.onMessage((message) => { if (isToServer(message)) status = message.status; });
  // The shell (re)learns the channel whenever a server starts, including after a crash restart.
  app.addHook("onReady", async () => { bridge?.send({ type: "update-config", channel: channel() }); });

  app.get("/api/system/updates", { preHandler: manage }, async () => state());
  app.put("/api/system/updates", { preHandler: manage }, async (req) => {
    const body = UpdateSettings.parse(req.body);
    db.prepare("UPDATE settings SET update_channel = ? WHERE id = 1").run(body.channel);
    bridge?.send({ type: "update-config", channel: body.channel });
    return state();
  });
  app.post("/api/system/updates/check", { preHandler: manage }, async (_req, reply) => {
    if (!bridge || status.state === "unsupported") throw httpError(409, status.message ?? "Updates are not available here");
    bridge.send({ type: "update-check" });
    return reply.status(202).send(state());
  });
  app.post("/api/system/updates/install", { preHandler: manage }, async (_req, reply) => {
    if (!bridge || status.state !== "ready") throw httpError(409, "No update is ready to install");
    const open = busyOrders();
    if (open) throw httpError(409, `Finish service first: ${open} order${open > 1 ? "s are" : " is"} open or waiting for payment. The update installs when ForkFlow is next quit.`, "orders_open");
    bridge.send({ type: "update-install" });
    return reply.status(202).send(state());
  });
}
