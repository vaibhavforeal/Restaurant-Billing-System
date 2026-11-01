// Remote access for support staff: ask a counter for it, watch it (the viewer's ICE servers), end it, and see a counter's history.
// The asking is all staff can do; the PC decides, and the session itself runs over the live sockets (live/hub.ts).
import { z } from "zod";
import { iceServersFor } from "../live/turn.js";
import type { RemoteViewerSetup } from "./api-types.js";
import { path, type Route } from "./context.js";
import { conflict, HttpError, json, notFound, readBody } from "./http.js";
import { endRemote, remoteSession, remoteSessionsWhere, requestRemote } from "../support/remote.js";
import { getInstallation } from "../store.js";

const Ask = z.object({
  installationId: z.string().uuid(), chatId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(1, "Say why you need to see the PC").max(200), mode: z.enum(["view", "control"]),
}).strict();

export const remoteRoutes: Route[] = [
  { method: "POST", path: path("/remote-sessions"), permission: "support.remote", handler: async (ctx) => {
    const ask = await readBody(ctx.request, Ask);
    const live = ctx.env.LIVE;
    if (!live) throw new HttpError(501, "Remote access needs the portal's live connection, which this server doesn't run", "no_live");
    const installation = await getInstallation(ctx.deps.db, ask.installationId);
    if (!installation) throw notFound("That counter");
    if (!live.counterOnline(installation.installationId)) throw conflict("That counter isn't connected right now. MasalaPOS must be open on the PC.", "counter_offline");
    if (ask.chatId && !(await ctx.deps.db.prepare(`SELECT 1 AS hit FROM support_chats WHERE id = ? AND installation_id = ?`).bind(ask.chatId, installation.installationId).first())) {
      throw new HttpError(400, "That chat isn't this counter's");
    }
    const pending = await remoteSessionsWhere(ctx.deps.db, "r.installation_id = ? AND r.status IN ('requested', 'approved', 'active')", [installation.installationId], 1);
    if (pending[0]) throw conflict(`This counter already has a remote session (${pending[0].status}) with ${pending[0].requestedBy.name}`, "remote_busy");
    const session = await requestRemote({ db: ctx.deps.db, live, now: ctx.deps.now, uuid: ctx.deps.uuid, env: ctx.env }, ctx.user,
      { installationId: installation.installationId, customerId: installation.customerId, chatId: ask.chatId ?? null, reason: ask.reason, mode: ask.mode });
    return json({ session }, 201);
  } },

  { method: "GET", path: path("/remote-sessions/:id"), permission: "support.remote", handler: async (ctx) => {
    const session = await remoteSession(ctx.deps.db, ctx.params[0]!);
    if (!session) throw notFound("That remote session");
    const setup: RemoteViewerSetup = { session, iceServers: await iceServersFor(ctx.env, `staff-${ctx.user.id.slice(0, 8)}`, ctx.deps.now()) };
    return json(setup);
  } },

  { method: "POST", path: path("/remote-sessions/:id/end"), permission: "support.remote", handler: async (ctx) => {
    const session = await remoteSession(ctx.deps.db, ctx.params[0]!);
    if (!session) throw notFound("That remote session");
    await endRemote({ db: ctx.deps.db, live: ctx.env.LIVE, now: ctx.deps.now, env: ctx.env }, session.id, `Ended by ${ctx.user.name}`);
    return json({ session: await remoteSession(ctx.deps.db, session.id) });
  } },

  { method: "GET", path: path("/installations/:id/remote-sessions"), permission: "support.remote", handler: async (ctx) =>
    json({ sessions: await remoteSessionsWhere(ctx.deps.db, "r.installation_id = ?", [ctx.params[0]!], 20), online: ctx.env.LIVE?.counterOnline(ctx.params[0]!) ?? false }) },
];
