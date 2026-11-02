// Support chats: the rows, and the one way a message gets in (stored first, then pushed to whoever is watching).
import type { D1Like, D1StatementLike } from "../env.js";
import type { LiveHub } from "../live/types.js";
import type { ChatMessage, ChatSummary, VisitorChat, VisitorMessage } from "../portal/api-types.js";

export const MESSAGE_MAX = 2000;

interface SummaryRow {
  id: string; number: number; status: ChatSummary["status"]; customerId: string; customerName: string; customerCode: string; installationId: string | null; outletName: string | null;
  visitorName: string | null; visitorPhone: string | null; assigneeId: string | null; assigneeName: string | null; ticketId: string | null; ticketNumber: number | null;
  createdAt: number; lastMessageAt: number; closedAt: number | null; lastAuthor: ChatMessage["author"] | null; lastBody: string | null;
}
const SUMMARY = `s.id, s.number, s.status, s.customer_id AS customerId, c.business_name AS customerName, c.code AS customerCode, s.installation_id AS installationId, i.outlet_name AS outletName,
  s.visitor_name AS visitorName, s.visitor_phone AS visitorPhone, s.assignee_id AS assigneeId, a.name AS assigneeName, s.ticket_id AS ticketId, t.number AS ticketNumber,
  s.created_at AS createdAt, s.last_message_at AS lastMessageAt, s.closed_at AS closedAt,
  (SELECT author_type FROM support_chat_messages m WHERE m.chat_id = s.id ORDER BY m.id DESC LIMIT 1) AS lastAuthor,
  (SELECT body FROM support_chat_messages m WHERE m.chat_id = s.id ORDER BY m.id DESC LIMIT 1) AS lastBody`;
const FROM = `FROM support_chats s JOIN customers c ON c.id = s.customer_id LEFT JOIN installations i ON i.installation_id = s.installation_id
  LEFT JOIN staff_users a ON a.id = s.assignee_id LEFT JOIN tickets t ON t.id = s.ticket_id`;

export const counterName = (installationId: string, outletName: string | null) => outletName ?? `Counter ${installationId.slice(0, 8)}`;

const toSummary = (r: SummaryRow): ChatSummary => ({
  id: r.id, number: r.number, status: r.status, customer: { id: r.customerId, name: r.customerName, code: r.customerCode },
  installation: r.installationId ? { id: r.installationId, name: counterName(r.installationId, r.outletName) } : null,
  visitorName: r.visitorName, visitorPhone: r.visitorPhone, assignee: r.assigneeId ? { id: r.assigneeId, name: r.assigneeName ?? "Former staff" } : null,
  ticket: r.ticketId && r.ticketNumber !== null ? { id: r.ticketId, number: r.ticketNumber } : null,
  createdAt: r.createdAt, lastMessageAt: r.lastMessageAt, closedAt: r.closedAt,
  lastMessage: r.lastAuthor && r.lastBody !== null ? { author: r.lastAuthor, body: r.lastBody.slice(0, 160) } : null,
});

export async function chatsWhere(db: D1Like, where: string, binds: unknown[], order = "s.last_message_at DESC", limit = 100): Promise<ChatSummary[]> {
  const { results } = await db.prepare(`SELECT ${SUMMARY} ${FROM} WHERE ${where} ORDER BY ${order} LIMIT ?`).bind(...binds, limit).all<SummaryRow>();
  return results.map(toSummary);
}

export async function chatSummary(db: D1Like, id: string): Promise<ChatSummary | null> {
  return (await chatsWhere(db, "s.id = ?", [id], "s.id", 1))[0] ?? null;
}

export async function chatMessages(db: D1Like, chatId: string, afterId = 0): Promise<ChatMessage[]> {
  const { results } = await db.prepare(`SELECT m.id, m.author_type AS author, m.author_id AS staffId, u.name AS staffName, m.body, m.created_at AS createdAt
    FROM support_chat_messages m LEFT JOIN staff_users u ON u.id = m.author_id WHERE m.chat_id = ? AND m.id > ? ORDER BY m.id LIMIT 500`)
    .bind(chatId, afterId).all<{ id: number; author: ChatMessage["author"]; staffId: string | null; staffName: string | null; body: string; createdAt: number }>();
  return results.map(({ staffId, staffName, ...m }) => ({ ...m, staff: staffId ? { id: staffId, name: staffName ?? "Support" } : null }));
}

/** The counter's open chat (waiting or active), if it has one. */
export async function openChatId(db: D1Like, installationId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT id FROM support_chats WHERE installation_id = ? AND status <> 'closed' ORDER BY created_at DESC LIMIT 1`).bind(installationId).first<{ id: string }>();
  return row?.id ?? null;
}

/** A first name for the restaurant to see: "Neha" for "Neha Sharma". */
export const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] ?? null;

export function toVisitorMessage(m: ChatMessage): VisitorMessage {
  return { id: m.id, author: m.author, name: m.author === "staff" ? firstName(m.staff?.name ?? null) ?? "Support" : null, body: m.body, createdAt: m.createdAt };
}

/** The restaurant's view of its counter's chat: the open one, or else the newest (so a closed chat still shows how it ended). */
export async function visitorChat(db: D1Like, installationId: string, afterId = 0): Promise<VisitorChat> {
  const where = await db.prepare(`SELECT i.outlet_name AS outletName, c.business_name AS customerName FROM installations i JOIN customers c ON c.id = i.customer_id
    WHERE i.installation_id = ?`).bind(installationId).first<{ outletName: string | null; customerName: string }>();
  const latest = await db.prepare(`SELECT id FROM support_chats WHERE installation_id = ? ORDER BY status = 'closed', created_at DESC LIMIT 1`)
    .bind(installationId).first<{ id: string }>();
  const summary = latest ? await chatSummary(db, latest.id) : null;
  return {
    outletName: counterName(installationId, where?.outletName ?? null), customerName: where?.customerName ?? "",
    chat: summary ? {
      id: summary.id, number: summary.number, status: summary.status, visitorName: summary.visitorName, agentName: firstName(summary.assignee?.name ?? null),
      messages: (await chatMessages(db, summary.id, afterId)).map(toVisitorMessage),
    } : null,
  };
}

export const insertMessageStatement = (db: D1Like, chatId: string, author: ChatMessage["author"], staffId: string | null, body: string, at: number): D1StatementLike =>
  db.prepare(`INSERT INTO support_chat_messages (chat_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)`).bind(chatId, author, staffId, body.slice(0, MESSAGE_MAX), at);
export const touchChatStatement = (db: D1Like, chatId: string, at: number): D1StatementLike =>
  db.prepare(`UPDATE support_chats SET last_message_at = ? WHERE id = ?`).bind(at, chatId);

/** Tells everyone watching that a chat changed: its new messages (after `afterId`) and its summary. */
export async function publishChat(db: D1Like, live: LiveHub | undefined, chatId: string, afterId: number, transientBody?: string): Promise<void> {
  if (!live) return;
  const summary = await chatSummary(db, chatId);
  if (!summary) return;
  const messages = await chatMessages(db, chatId, afterId);
  if (transientBody && messages.length) messages[messages.length-1]!.body = transientBody;
  live.toStaff({ type: "chat.updated", chat: summary, messages });
  live.toChat?.(chatId, { type: "chat.updated", chatId, messages: messages.map(toVisitorMessage) });
  // The restaurant's page gets its own shape, without staff surnames.
  if (summary.installation) live.toVisitors(summary.installation.id, { type: "visitor.updated", chatId, status: summary.status, agentName: firstName(summary.assignee?.name ?? null),
    messages: messages.map(toVisitorMessage) });
}

/** The id the next message will get, minus one: what `publishChat` should send after. */
export async function lastMessageId(db: D1Like, chatId: string): Promise<number> {
  return (await db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM support_chat_messages WHERE chat_id = ?`).bind(chatId).first<{ id: number }>())?.id ?? 0;
}

/** A line from the service in the chat ("Neha asked to see this PC"), stored and pushed. */
export async function addSystemMessage(db: D1Like, live: LiveHub | undefined, chatId: string, body: string, at: number, transientBody?: string): Promise<void> {
  const after = await lastMessageId(db, chatId);
  await db.batch([insertMessageStatement(db, chatId, "system", null, body, at), touchChatStatement(db, chatId, at)]);
  await publishChat(db, live, chatId, after, transientBody);
}
