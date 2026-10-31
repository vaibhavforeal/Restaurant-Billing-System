// Live chat for support staff: the inbox, a chat with its counter's context, replies, hand-offs, closing, and turning a chat into a ticket.
import { z } from "zod";
import type { ChatDetail } from "./api-types.js";
import { logBy, path, type Ctx, type Route } from "./context.js";
import { conflict, HttpError, json, notFound, readBody } from "./http.js";
import { addSystemMessage, chatMessages, chatsWhere, chatSummary, firstName, insertMessageStatement, lastMessageId, MESSAGE_MAX, publishChat, touchChatStatement } from "../support/chats.js";
import { remoteSessionsWhere } from "../support/remote.js";

const Reply = z.object({ body: z.string().trim().min(1, "Write a reply").max(MESSAGE_MAX) }).strict();
const ChatChange = z.object({ assigneeId: z.string().uuid().nullable().optional(), status: z.enum(["active", "closed"]).optional() }).strict();
const ToTicket = z.object({
  subject: z.string().trim().min(1, "Say what's wrong").max(160),
  category: z.enum(["activation", "licence", "billing", "printing", "hardware", "training", "bug", "other"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
}).strict();

async function detail(ctx: Ctx, id: string): Promise<ChatDetail> {
  const summary = await chatSummary(ctx.deps.db, id);
  if (!summary) throw notFound("That chat");
  return {
    ...summary, messages: await chatMessages(ctx.deps.db, id), counterOnline: ctx.env.LIVE?.counterOnline(summary.installation.id) ?? false,
    remoteSessions: await remoteSessionsWhere(ctx.deps.db, "r.installation_id = ?", [summary.installation.id], 5),
  };
}

async function checkAssignee(ctx: Ctx, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  if (!(await ctx.deps.db.prepare(`SELECT 1 AS hit FROM staff_users WHERE id = ? AND active = 1 AND role IN ('admin', 'support')`).bind(assigneeId).first())) {
    throw new HttpError(400, "Hand the chat to an active support person or admin");
  }
}

export const supportChatRoutes: Route[] = [
  { method: "GET", path: path("/chats"), permission: "support.chat", handler: async (ctx) => {
    const view = ctx.url.searchParams.get("view") ?? "open", db = ctx.deps.db;
    const chats = view === "closed" ? await chatsWhere(db, "s.status = 'closed'", [], "s.closed_at DESC", 100)
      : view === "mine" ? await chatsWhere(db, "s.status <> 'closed' AND s.assignee_id = ?", [ctx.user.id], "s.last_message_at DESC")
      // Waiting chats first, oldest first: they have waited longest for a first answer.
      : await chatsWhere(db, "s.status <> 'closed'", [], "s.status = 'active', s.created_at", 200);
    const counts = await db.prepare(`SELECT status, COUNT(*) AS n FROM support_chats WHERE status <> 'closed' GROUP BY status`).all<{ status: string; n: number }>();
    return json({ chats, counts: { waiting: 0, active: 0, ...Object.fromEntries(counts.results.map((c) => [c.status, c.n])) } });
  } },

  { method: "GET", path: path("/chats/:id"), permission: "support.chat", handler: async (ctx) => json({ chat: await detail(ctx, ctx.params[0]!) }) },

  { method: "POST", path: path("/chats/:id/messages"), permission: "support.chat", handler: async (ctx) => {
    const chat = await detail(ctx, ctx.params[0]!);
    if (chat.status === "closed") throw conflict("This chat is closed. The restaurant can start a new one from MasalaPOS.");
    const { body } = await readBody(ctx.request, Reply);
    const { db } = ctx.deps, now = ctx.deps.now(), after = await lastMessageId(db, chat.id);
    // The first reply picks the chat up: it becomes active and, if nobody has it, it is the replier's.
    await db.batch([
      insertMessageStatement(db, chat.id, "staff", ctx.user.id, body, now), touchChatStatement(db, chat.id, now),
      db.prepare(`UPDATE support_chats SET status = 'active', assignee_id = COALESCE(assignee_id, ?) WHERE id = ?`).bind(ctx.user.id, chat.id),
    ]);
    await publishChat(db, ctx.env.LIVE, chat.id, after);
    return json({ chat: await detail(ctx, chat.id) }, 201);
  } },

  { method: "PATCH", path: path("/chats/:id"), permission: "support.chat", handler: async (ctx) => {
    const before = await detail(ctx, ctx.params[0]!);
    const change = await readBody(ctx.request, ChatChange);
    if (change.assigneeId !== undefined) await checkAssignee(ctx, change.assigneeId);
    const { db } = ctx.deps, now = ctx.deps.now(), after = await lastMessageId(db, before.id);
    const assigneeId = change.assigneeId === undefined ? before.assignee?.id ?? null : change.assigneeId;
    const status = change.status ?? (change.assigneeId && before.status === "waiting" ? "active" : before.status);
    if (before.status === "closed" && status === "closed" && change.assigneeId === undefined) return json({ chat: before });
    await db.batch([
      db.prepare(`UPDATE support_chats SET status = ?, assignee_id = ?, closed_at = ? WHERE id = ?`).bind(status, assigneeId, status === "closed" ? before.closedAt ?? now : null, before.id),
      ...(status === "closed" && before.status !== "closed"
        ? [logBy(ctx, { action: "chat.closed", entityType: "support_chat", entityId: before.id, customerId: before.customer.id, summary: `Closed chat C-${before.number}` })] : []),
    ]);
    if (status === "closed" && before.status !== "closed") await addSystemMessage(db, ctx.env.LIVE, before.id, `${firstName(ctx.user.name)} closed this chat. Click Get support in MasalaPOS to start a new one.`, now);
    else if (change.assigneeId && change.assigneeId !== before.assignee?.id) {
      const who = await db.prepare(`SELECT name FROM staff_users WHERE id = ?`).bind(change.assigneeId).first<{ name: string }>();
      await addSystemMessage(db, ctx.env.LIVE, before.id, `${firstName(who?.name ?? null) ?? "Support"} has joined the chat.`, now);
    } else await publishChat(db, ctx.env.LIVE, before.id, after);
    return json({ chat: await detail(ctx, before.id) });
  } },

  { method: "POST", path: path("/chats/:id/ticket"), permission: "tickets.write", handler: async (ctx) => {
    const chat = await detail(ctx, ctx.params[0]!);
    if (chat.ticket) throw conflict(`This chat is already ticket T-${chat.ticket.number}`);
    const body = await readBody(ctx.request, ToTicket);
    const transcript = chat.messages.map((m) => `${m.author === "staff" ? m.staff?.name ?? "Support" : m.author === "customer" ? chat.visitorName ?? "Restaurant" : "—"}: ${m.body}`).join("\n");
    const header = `From live chat C-${chat.number}${chat.visitorPhone ? ` (${chat.visitorName ?? "restaurant"}, ${chat.visitorPhone})` : ""}.\n\n`;
    const description = (header + transcript).slice(0, 4000);
    const { db } = ctx.deps, now = ctx.deps.now(), id = ctx.deps.uuid();
    await db.batch([
      db.prepare(`INSERT INTO tickets (id, number, customer_id, installation_id, subject, description, category, priority, assignee_id, created_by, created_at, updated_at)
        SELECT ?, COALESCE(MAX(number), 1000) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM tickets`)
        .bind(id, chat.customer.id, chat.installation.id, body.subject, description, body.category, body.priority, chat.assignee?.id ?? ctx.user.id, ctx.user.id, now, now),
      db.prepare(`UPDATE support_chats SET ticket_id = ? WHERE id = ?`).bind(id, chat.id),
      logBy(ctx, { action: "ticket.opened", entityType: "ticket", entityId: id, customerId: chat.customer.id, summary: `Opened a ticket from chat C-${chat.number}: ${body.subject}` }),
    ]);
    const ticket = await db.prepare(`SELECT number FROM tickets WHERE id = ?`).bind(id).first<{ number: number }>();
    await addSystemMessage(db, ctx.env.LIVE, chat.id, `Ticket T-${ticket!.number} opened to follow this up.`, now);
    return json({ chat: await detail(ctx, chat.id), ticketId: id }, 201);
  } },

  { method: "GET", path: path("/customers/:id/chats"), permission: "support.chat", handler: async (ctx) =>
    json({ chats: await chatsWhere(ctx.deps.db, "s.customer_id = ?", [ctx.params[0]!], "s.created_at DESC", 50) }) },
];
