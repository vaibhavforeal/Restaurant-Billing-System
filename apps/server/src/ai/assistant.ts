import type { Database } from "@masalapos/domain";
import { orderAnalyticsReport } from "../order-analytics.js";
import { dayEndReport } from "../reports.js";
import { reportRange } from "../sales-reports.js";
import { AI_TOOLS, runTool } from "./tools.js";
import { AiError, type AiMessage, type AiProvider, type AiReply, type AiUsage } from "./provider.js";

export const MAX_LOOKUPS = 6;
export type ChatTurn = { role: "user" | "assistant"; text: string };

export const ASK_SYSTEM = `You are MasalaPOS's assistant for the owner of an Indian restaurant. Answer questions about the restaurant's sales using only the results of the lookups you are given; call a lookup whenever you need figures, and use the "today" lookup to work out dates. Never invent or estimate figures the lookups did not return, and say plainly when the data doesn't cover the question. Amounts are in Indian rupees (₹). Be brief and practical: a few sentences or short bullet points, with the numbers that matter and one useful suggestion when it fits. Answer in the language the owner writes in.`;
export const SUMMARY_SYSTEM = `You write a short end-of-day summary for the owner of an Indian restaurant from the figures given. Write 5 to 8 bullet points starting with "• ": net sales and bills compared with the usual for this weekday (when an average is given), the best and weakest sellers, voids, refunds and discounts worth a look, and any staff flags. Use only the figures given, in rupees (₹). Plain, friendly and brief; no heading.`;
export const DESCRIBE_SYSTEM = `You write menu descriptions for an Indian restaurant's QR menu. Write one or two appetising lines, at most 200 characters, from the dish details given. Don't claim ingredients, spice levels or cooking methods the details don't support beyond what the dish name clearly implies. Reply with the description only, without quotes.`;

const rs = (paise: number) => Math.round(paise) / 100;
const sumUsage = (a: AiUsage, b: AiUsage): AiUsage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });
const DAY_MS = 24 * 60 * 60 * 1000;
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The browser's chat history, made safe: the last 10 user/assistant turns, each at most 2,000 characters. */
export function cleanHistory(history: unknown): ChatTurn[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter((turn): turn is ChatTurn => !!turn && typeof turn === "object" && ((turn as ChatTurn).role === "user" || (turn as ChatTurn).role === "assistant") && typeof (turn as ChatTurn).text === "string")
    .slice(-10).map((turn) => ({ role: turn.role, text: turn.text.slice(0, 2000) }));
}

/**
 * Ask your sales: the model calls lookups (at most MAX_LOOKUPS), then answers. When the lookups are used up, the
 * results so far are handed back as plain text with no lookups offered, so it must answer (some providers reject tool
 * history in a request that offers no tools).
 */
export async function ask(provider: AiProvider, db: Database, question: string, history: ChatTurn[], now: number) {
  const messages: AiMessage[] = [...history.map((t): AiMessage => ({ role: t.role, text: t.text })), { role: "user", text: question }];
  const figuresUsed: string[] = [];
  const results: string[] = [];
  let usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
  let lookups = 0;
  let model = "";
  while (lookups < MAX_LOOKUPS) {
    const reply: AiReply = await provider.chat({ system: ASK_SYSTEM, messages, tools: AI_TOOLS, maxTokens: 1500 });
    usage = sumUsage(usage, reply.usage); model = reply.model;
    if (!reply.toolCalls.length) return { answer: reply.text, figuresUsed, model, usage };
    messages.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const run = lookups < MAX_LOOKUPS ? runTool(db, call.name, call.arguments, now) : { content: JSON.stringify({ error: "No more lookups are available." }), used: "" };
      lookups++;
      if (run.used) figuresUsed.push(run.used);
      results.push(`${call.name} ${call.arguments}: ${run.content}`);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: run.content });
    }
  }
  const final = await provider.chat({ system: ASK_SYSTEM, maxTokens: 1500, messages: [
    ...history.map((t): AiMessage => ({ role: t.role, text: t.text })),
    { role: "user", text: `${question}\n\nResults of the lookups made for this question:\n${results.join("\n")}\n\nNo more lookups are available. Answer now from these results.` },
  ] });
  usage = sumUsage(usage, final.usage);
  if (!final.text) throw new AiError("no_answer", "no final answer");
  return { answer: final.text, figuresUsed, model: final.model, usage };
}

/** The figures behind a day's summary: totals, best and weakest dishes, the usual for this weekday, and staff flags (first names). */
export function daySummaryInput(db: Database, date: string): object {
  const settings = db.prepare("SELECT restaurant_name AS name, city FROM settings WHERE id = 1").get() as { name: string; city: string | null };
  // dayEndReport's own return type is loose; these are the fields it fills (apps/server/src/reports.ts).
  const day = dayEndReport(db, date) as unknown as {
    sales: { billCount: number; discountPaise: number; outstandingPaise: number }; cancellations: { orderCount: number };
    creditNotes: { count: number; totalPaise: number }; net: { totalPaise: number }; netPayments: Array<{ mode: string; amountPaise: number }>;
  };
  const items = orderAnalyticsReport(db, reportRange({ from: date, to: date }), "all").items;
  const dish = (i: (typeof items)[number]) => ({ dish: i.name, category: i.category, plates: i.qty, salesRs: rs(i.totalPaise) });
  const first = (db.prepare("SELECT MIN(strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')) AS day FROM bills WHERE status <> 'void'").get() as { day: string | null }).day;
  const sameWeekdays = [7, 14, 21, 28].map((n) => shiftDay(date, -n)).filter((d) => first !== null && d >= first);
  const daily = sameWeekdays.length ? orderAnalyticsReport(db, reportRange({ from: sameWeekdays.at(-1)!, to: sameWeekdays[0]! }), "all").daily : [];
  const past = daily.filter((d) => sameWeekdays.includes(d.date));
  const staff = JSON.parse(runTool(db, "staff_activity", JSON.stringify({ from: date, to: date }), Date.now()).content) as { flags?: unknown; byStaff?: unknown };
  return {
    restaurant: { name: settings.name, city: settings.city ?? "" },
    date, weekday: new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
    totals: { bills: day.sales.billCount, netSalesRs: rs(day.net.totalPaise), discountsRs: rs(day.sales.discountPaise), unpaidRs: rs(day.sales.outstandingPaise),
      cancelledOrders: day.cancellations.orderCount, voidsAndRefunds: { count: day.creditNotes.count, amountRs: rs(day.creditNotes.totalPaise) },
      payments: day.netPayments.map((p) => ({ mode: p.mode, amountRs: rs(p.amountPaise) })) },
    top5: items.slice(0, 5).map(dish),
    bottom5: [...items].reverse().slice(0, 5).map(dish),
    weekdayAverage: { days: past.length, netSalesRs: past.length ? rs(past.reduce((n, d) => n + d.totalPaise, 0) / past.length) : null },
    staff: { flags: staff.flags ?? [], byStaff: staff.byStaff ?? [] },
  };
}

export async function daySummary(provider: AiProvider, db: Database, date: string) {
  const reply = await provider.chat({ system: SUMMARY_SYSTEM, maxTokens: 800, messages: [{ role: "user", text: `Figures for ${date}:\n${JSON.stringify(daySummaryInput(db, date))}` }] });
  if (!reply.text) throw new AiError("no_answer", "empty summary");
  return { text: reply.text, model: reply.model, usage: reply.usage };
}

/** At most 200 characters, cut at the last sentence end (or word) that fits. */
function fit(text: string): string {
  const clean = text.trim().replace(/^["“']+|["”']+$/g, "").trim();
  if (clean.length <= 200) return clean;
  const head = clean.slice(0, 200);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), /[.!?]$/.test(head) ? head.length - 1 : -1);
  if (sentence >= 60) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(" ");
  return `${head.slice(0, word > 0 ? word : 199).trimEnd()}…`.slice(0, 200);
}

export async function describeDish(provider: AiProvider, input: { name: string; category: string; isVeg: boolean; sizes: string[]; current?: string }) {
  const details = [`Dish: ${input.name}`, `Category: ${input.category}`, `Type: ${input.isVeg ? "vegetarian" : "non-vegetarian"}`,
    ...(input.sizes.length ? [`Sizes: ${input.sizes.join(", ")}`] : []), ...(input.current ? [`Current description to improve: ${input.current}`] : [])];
  const reply = await provider.chat({ system: DESCRIBE_SYSTEM, maxTokens: 200, messages: [{ role: "user", text: details.join("\n") }] });
  const text = fit(reply.text);
  if (!text) throw new AiError("no_answer", "empty description");
  return { text, model: reply.model, usage: reply.usage };
}

