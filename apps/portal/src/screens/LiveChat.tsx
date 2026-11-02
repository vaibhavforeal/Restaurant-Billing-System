import { SupportMessage } from "../SupportMessage";
// Live chat: restaurants write from MasalaPOS's Get support button; support answers here. The inbox and the open chat update as
// messages arrive (live socket), and fall back to checking every few seconds when the socket is down.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatDetail, ChatMessage, ChatSummary, Colleague, RemoteMode, RemoteSession, StaffUser, TicketCategory, TicketPriority } from "../../../licensing-worker/src/portal/api-types";
import { roleCan } from "../../../licensing-worker/src/portal/shared";
import { api, patch, post, query } from "../api";
import { dateTime, relativeDay, timeOfDay } from "../format";
import { chime, notify, portalLive, useCounterOnline, useLiveConnected, useLiveEvent } from "../live";
import { Link, navigate } from "../router";
import { Dialog, Field, LoadError, PageHead, Pill, Tabs, useData, useRun, type Tone } from "../ui";

type View = "open" | "mine" | "closed";
const STATUS: Record<ChatSummary["status"], [string, Tone]> = { waiting: ["Waiting", "warning"], active: ["Active", "positive"], closed: ["Closed", "neutral"] };
export const REMOTE_STATUS: Record<RemoteSession["status"], [string, Tone]> = {
  requested: ["Waiting for the PC", "warning"], approved: ["Allowed, starting", "accent"], active: ["Live", "positive"],
  denied: ["Refused", "negative"], expired: ["No answer", "neutral"], ended: ["Ended", "neutral"],
};
const MODE_NAMES: Record<RemoteMode, string> = { view: "View only", control: "View and control" };

/** Merges new messages into a list by id, in order. */
function merge(list: ChatMessage[], more: ChatMessage[]): ChatMessage[] {
  const seen = new Set(list.map((m) => m.id));
  return [...list, ...more.filter((m) => !seen.has(m.id))].sort((a, b) => a.id - b.id);
}

/** Polls while the live socket is down, so nothing waits for a reconnect. */
function usePollWhileOffline(reload: () => void, everyMs = 5_000) {
  const connected = useLiveConnected();
  useEffect(() => {
    if (connected) return;
    const timer = setInterval(reload, everyMs);
    return () => clearInterval(timer);
  }, [connected, reload, everyMs]);
}

export function LiveChat({ me, chatId }: { me: StaffUser; chatId?: string }) {
  const [view, setView] = useState<View>("open");
  const key = query({ view });
  const { data, error, reload, setData } = useData(() => api<{ chats: ChatSummary[]; counts: { waiting: number; active: number } }>(`/chats${key}`), key);
  usePollWhileOffline(reload);
  const connected = useLiveConnected();
  useLiveEvent((event) => {
    if (event.type !== "chat.updated") return;
    const chat = event["chat"] as ChatSummary;
    setData((current) => {
      if (!current) return current;
      const fits = view === "closed" ? chat.status === "closed" : chat.status !== "closed" && (view === "open" || chat.assignee?.id === me.id);
      const others = current.chats.filter((c) => c.id !== chat.id);
      return { ...current, chats: fits ? [chat, ...others].sort(order(view)) : others };
    });
    void api<{ counts: { waiting: number; active: number } }>("/chats?view=mine").then((r) => setData((current) => current && { ...current, counts: r.counts })).catch(() => {});
  });
  const counts = data?.counts ?? { waiting: 0, active: 0 };
  return <div className="chat-page">
    <PageHead title="Live chat" sub={data ? <>{counts.waiting} waiting · {counts.active} active{!connected && " · reconnecting, checking every few seconds"}</> : "Loading chats…"}
      actions={<AlertsButton />} />
    <div className={`chat-layout${chatId ? " has-chat" : ""}`}>
      <section className="chat-inbox" aria-label="Chats">
        <Tabs label="Chats" value={view} onChange={setView} tabs={[{ id: "open", label: <>Open<span className="count">{counts.waiting + counts.active}</span></> },
          { id: "mine", label: "Mine" }, { id: "closed", label: "Closed" }]} />
        {error && <LoadError message={error} retry={reload} />}
        <ul className="chat-list">
          {data?.chats.map((c) => <li key={c.id}><Link to={`/chats/${c.id}`} className="chat-row" aria-current={c.id === chatId ? "page" : undefined}>
            <span className="chat-row-top"><strong>{c.customer.name}</strong><span className="muted small">{relativeTime(c.lastMessageAt)}</span></span>
            <span className="muted small">{c.customer.code}</span>
            <span className="chat-row-last">{c.lastMessage ? `${c.lastMessage.author === "staff" ? "Support: " : ""}${c.lastMessage.body}` : "—"}</span>
            <span className="chat-row-tags">
              <span className="chat-row-context muted small" title={`${c.installation?.name ?? "Support PC"}${c.visitorName ? ` · ${c.visitorName}` : ""}`}>
                {c.installation?.name ?? "Support PC"}{c.visitorName ? ` · ${c.visitorName}` : ""}
              </span>
              <Pill tone={STATUS[c.status][1]}>{STATUS[c.status][0]}</Pill>
              {c.assignee && <span className="chat-row-assignee muted small" title={`With ${c.assignee.name}`}>{c.assignee.id === me.id ? "With you" : `With ${c.assignee.name}`}</span>}
            </span>
          </Link></li>)}
          {data && data.chats.length === 0 && <li className="empty-block">{view === "closed" ? "No closed chats yet." : "No one is waiting. New chats appear here as they arrive."}</li>}
        </ul>
      </section>
      {chatId ? <ChatPane key={chatId} id={chatId} me={me} /> : <section className="chat-pane chat-empty"><p className="muted">Pick a chat on the left.</p></section>}
    </div>
  </div>;
}

const order = (view: View) => (a: ChatSummary, b: ChatSummary) =>
  view === "open" ? (a.status === b.status ? a.createdAt - b.createdAt : a.status === "waiting" ? -1 : 1) : b.lastMessageAt - a.lastMessageAt;

function relativeTime(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  return relativeDay(at) === "Today" ? timeOfDay(at) : relativeDay(at);
}

function AlertsButton() {
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  if (permission !== "default") return null;
  return <button className="secondary" onClick={() => void Notification.requestPermission().then(setPermission)}>Turn on desktop alerts</button>;
}

function ChatPane({ id, me }: { id: string; me: StaffUser }) {
  const { data, error, reload, setData } = useData(() => api<{ chat: ChatDetail }>(`/chats/${id}`), id);
  const staff = useData(() => api<{ staff: Colleague[] }>("/staff"), "staff");
  const [reply, setReply] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [typingUntil, setTypingUntil] = useState(0);
  const [dialog, setDialog] = useState<"ticket" | "remote" | null>(null);
  const { busy, run, status } = useRun();
  const messageBody = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  usePollWhileOffline(reload);
  const chat = data?.chat;
  const online = useCounterOnline(chat?.installation?.id);

  useLiveEvent((event) => {
    if (event.type === "chat.updated" && (event["chat"] as ChatSummary).id === id) {
      const summary = event["chat"] as ChatSummary, messages = event["messages"] as ChatMessage[];
      setData((current) => current && { chat: { ...current.chat, ...summary, messages: merge(current.chat.messages, messages) } });
      if (messages.some((m) => m.author === "customer")) setTypingUntil(0);
    } else if (event.type === "chat.typing" && event["installationId"] === chat?.installation?.id) setTypingUntil(Date.now() + 5_000);
    else if (event.type === "remote.updated") {
      const session = event["session"] as RemoteSession;
      setData((current) => current && session.chatId === current.chat.id
        ? { chat: { ...current.chat, remoteSessions: [session, ...current.chat.remoteSessions.filter((s) => s.id !== session.id)].slice(0, 5) } } : current);
    }
  });
  useEffect(() => {
    const body = messageBody.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [chat?.messages.length]);
  const [, tick] = useState(0);
  useEffect(() => { if (typingUntil <= Date.now()) return; const t = setTimeout(() => tick((n) => n + 1), typingUntil - Date.now() + 50); return () => clearTimeout(t); }, [typingUntil]);

  if (error) return <section className="chat-pane"><Link to="/chats" className="chat-back">Back to chats</Link><LoadError message={error} retry={reload} /></section>;
  if (!chat) return <section className="chat-pane chat-empty"><Link to="/chats" className="chat-back">Back to chats</Link><p className="muted">Loading…</p></section>;
  const closed = chat.status === "closed";
  const mine = chat.assignee?.id === me.id;
  const change = (body: { assigneeId?: string | null; status?: "active" | "closed" }, done = "") => run(async () => setData(await patch<{ chat: ChatDetail }>(`/chats/${id}`, body)), done);
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const body = reply.trim();
    if (!body || busy) return;
    void run(async () => { setData(await post<{ chat: ChatDetail }>(`/chats/${id}/messages`, { body })); setReply(""); });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); return; }
    if (Date.now() - lastTyping.current > 3_000) { lastTyping.current = Date.now(); portalLive.send({ type: "typing", chatId: id }); }
  };
  const openRemote = chat.remoteSessions.find((s) => s.status === "requested" || s.status === "approved" || s.status === "active");
  const canRemote = roleCan(me.role, "support.remote");
  return <section className="chat-pane" aria-label={`Chat with ${chat.customer.name}`}>
    <header className="chat-head">
      <div className="chat-heading">
        <Link to="/chats" className="chat-back">Back to chats</Link>
        <h2>{chat.customer.name} <span className="muted">· {chat.customer.code} · C-{chat.number}</span></h2>
        <p className="chat-meta muted small">{chat.installation?.name ?? "Support PC"}{chat.visitorName ? ` · ${chat.visitorName}` : ""}
          <Pill tone={STATUS[chat.status][1]}>{STATUS[chat.status][0]}</Pill>
          {canRemote && openRemote && <Link to={`/remote/${openRemote.id}`}>Open viewer</Link>}
        </p>
      </div>
      <div className="actions">
        {!closed && !mine && <button className="secondary small" disabled={busy} onClick={() => void change({ assigneeId: me.id }, "The chat is yours.")}>Take this chat</button>}
        {canRemote && !closed && <button className="secondary small" disabled={busy || !!openRemote}
          onClick={() => setDialog("remote")}>Send connector</button>}
        <button type="button" className="secondary small" aria-expanded={showDetails} aria-controls={`chat-details-${id}`} onClick={() => setShowDetails(!showDetails)}>Details</button>
      </div>
    </header>
    {status}
    <aside className="chat-rail" id={`chat-details-${id}`} aria-label="Chat details" hidden={!showDetails}>
      <dl className="kv">
        <dt>Restaurant</dt><dd><Link to={`/customers/${chat.customer.id}`}>{chat.customer.name}</Link></dd>
        <dt>Customer ID</dt><dd>{chat.customer.code}</dd>
        <dt>Counter</dt><dd>{chat.installation?.name ?? "Support PC"} {online === null ? null : online ? <Pill tone="positive">Connected</Pill> : <Pill>Offline</Pill>}</dd>
        <dt>With</dt><dd>{closed ? chat.assignee?.name ?? "Nobody" : <select aria-label="With" value={chat.assignee?.id ?? ""} disabled={busy} onChange={(e) => void change({ assigneeId: e.target.value || null })}>
          <option value="">Nobody yet</option>{staff.data?.staff.filter((s) => s.role === "support" || s.role === "admin").map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === me.id ? " (me)" : ""}</option>)}</select>}</dd>
        {chat.visitorPhone && <><dt>Phone</dt><dd>{chat.visitorPhone}</dd></>}
        <dt>Started</dt><dd>{dateTime(chat.createdAt)}</dd>
        {chat.ticket && <><dt>Ticket</dt><dd><Link to={`/tickets/${chat.ticket.id}`}>T-{chat.ticket.number}</Link></dd></>}
      </dl>
      {canRemote && chat.remoteSessions.length > 0 && <section><h3 className="rail-title">Remote access</h3>
        <ul className="remote-list">{chat.remoteSessions.map((s) => <li key={s.id}>
          <Pill tone={REMOTE_STATUS[s.status][1]}>{REMOTE_STATUS[s.status][0]}</Pill> <span className="muted small">{MODE_NAMES[s.mode ?? s.modeRequested]} · {relativeTime(s.requestedAt)}</span>
          {(s.status === "requested" || s.status === "approved" || s.status === "active") && <div><Link to={`/remote/${s.id}`}>Open the viewer</Link></div>}
        </li>)}</ul></section>}
      <div className="actions chat-detail-actions">
        {!chat.ticket && roleCan(me.role, "tickets.write") && <button className="secondary small" disabled={busy} onClick={() => setDialog("ticket")}>Open a ticket</button>}
        {!closed && <button className="secondary small" disabled={busy} onClick={() => void change({ status: "closed" }, "Chat closed.")}>Close chat</button>}
      </div>
    </aside>
    <div className="chat-body" ref={messageBody}>
      <ol className="chat-messages">
        {chat.messages.map((m) => m.author === "system"
          ? <li key={m.id} className="msg system"><span>{<SupportMessage body={m.body} />}</span><time className="muted small">{timeOfDay(m.createdAt)}</time></li>
          : <li key={m.id} className={`msg ${m.author === "staff" ? "out" : "in"}`}>
            <div className="bubble">{<SupportMessage body={m.body} />}</div>
            <div className="muted small">{m.author === "staff" ? (m.staff?.id === me.id ? "You" : m.staff?.name ?? "Support") : chat.visitorName ?? "Restaurant"} · {timeOfDay(m.createdAt)}</div>
          </li>)}
        {typingUntil > Date.now() && <li className="msg in typing muted small">{chat.visitorName ?? "The restaurant"} is typing…</li>}
      </ol>
    </div>
    {closed ? <p className="chat-closed muted">This chat is closed{chat.closedAt ? ` (${dateTime(chat.closedAt)})` : ""}. The restaurant can start a new one from MasalaPOS.</p>
      : <form className="chat-composer" onSubmit={send}>
        <textarea rows={2} maxLength={2000} aria-label="Reply" aria-describedby="chat-reply-hint" placeholder="Write a reply…" value={reply}
          onChange={(e) => setReply(e.target.value)} onKeyDown={onKey} disabled={busy} />
        <button className="primary" disabled={busy || !reply.trim()}>Send</button>
        <span id="chat-reply-hint" className="chat-reply-hint muted small">Enter to send · Shift+Enter for a new line</span>
      </form>}
    {dialog === "ticket" && <TicketDialog chat={chat} onClose={() => setDialog(null)} onDone={(c) => { setData({ chat: c }); setDialog(null); }} />}
    {dialog === "remote" && <RemoteDialog chatId={chat.id} onClose={() => setDialog(null)} />}
  </section>;
}

const CATEGORIES: Record<TicketCategory, string> = { activation: "Activation", licence: "Licence or plan", billing: "Billing and invoices", printing: "Printing",
  hardware: "Hardware", training: "Training", bug: "Something broken", other: "Other" };

function TicketDialog({ chat, onClose, onDone }: { chat: ChatDetail; onClose: () => void; onDone: (chat: ChatDetail) => void }) {
  const first = chat.messages.find((m) => m.author === "customer")?.body ?? "";
  const [form, setForm] = useState({ subject: first.slice(0, 160), category: "other" as TicketCategory, priority: "normal" as TicketPriority });
  const { busy, run, status } = useRun();
  return <Dialog title="Open a ticket from this chat" onClose={onClose}>
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => onDone((await post<{ chat: ChatDetail }>(`/chats/${chat.id}/ticket`, form)).chat)); }}>
      <p className="muted">The ticket gets the whole conversation so far. Use it when the problem needs follow-up after the chat.</p>
      <Field label="What's wrong"><input required autoFocus maxLength={160} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} disabled={busy} /></Field>
      <Field label="Kind"><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as TicketCategory })} disabled={busy}>
        {Object.entries(CATEGORIES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></Field>
      <Field label="Priority" hint="Urgent: the restaurant can't bill."><select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TicketPriority })} disabled={busy}>
        <option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></Field>
      {status}
      <div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Open ticket</button></div>
    </form>
  </Dialog>;
}

export function RemoteDialog({ chatId, customerId, onClose }: { chatId?: string; customerId?: string; onClose: () => void }) {
  const [form, setForm] = useState({ reason: "", mode: "control" as RemoteMode });
  const { busy, run, status } = useRun();
  const availability = useData(() => api<{ available: boolean }>("/connector"), "connector");
  const [invitation, setInvitation] = useState<{ url: string; code: string; sessionId: string } | null>(null);
  return <Dialog title="Send Support Connector" onClose={onClose}>
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => {
      setInvitation(await post<{ url: string; code: string; sessionId: string }>("/connector", { ...(chatId ? { chatId } : { customerId }), ...form }));
    }); }}>
      <p className="muted">The restaurant downloads and runs a small connector, then chooses what to allow. MasalaPOS does not need to be installed on that PC.</p>
      {availability.data?.available === false && <p className="notice">Connector distribution is not enabled yet.</p>}
      {invitation && <div className="panel"><p>Send this link to the person at the PC:</p><input aria-label="Connector download link" readOnly value={invitation.url} onFocus={(e)=>e.target.select()} /><p>Fallback code: <strong>{invitation.code}</strong></p><button type="button" className="secondary" onClick={()=>void navigator.clipboard.writeText(invitation.url)}>Copy link</button> <button type="button" className="primary" onClick={()=>navigate(`/remote/${invitation.sessionId}`)}>Open viewer</button></div>}
      <Field label="Why you need to see the PC" hint="The restaurant reads this."><input required autoFocus maxLength={200} value={form.reason}
        onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Check the KOT printer settings" disabled={busy} /></Field>
      <fieldset className="choice"><legend className="field-label">Access</legend>
        {(["control", "view"] as const).map((mode) => <label key={mode}><input type="radio" name="mode" checked={form.mode === mode} onChange={() => setForm({ ...form, mode })} disabled={busy} />
          {MODE_NAMES[mode]}<span className="field-hint">{mode === "control" ? "You can use the mouse and keyboard." : "You see the screen; they do the clicking."}</span></label>)}
      </fieldset>
      {status}
      <div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !!invitation || !availability.data?.available}>Send connector</button></div>
    </form>
  </Dialog>;
}

/**
 * For the shell: the number of chats waiting for a first answer, kept current from the live socket, and a chime plus a desktop notification
 * when a restaurant writes. Only for staff who can answer chats.
 */
export function useChatAlerts(enabled: boolean, path: string): number {
  const [waiting, setWaiting] = useState(0);
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    if (!enabled) return;
    const load = () => void api<{ counts: { waiting: number } }>("/chats?view=mine").then((r) => setWaiting(r.counts.waiting)).catch(() => {});
    load();
    const timer = setInterval(() => { if (!portalLive.connected) load(); }, 15_000);
    const off = portalLive.subscribe((event) => {
      if (event.type !== "chat.updated") return;
      load();
      const chat = event["chat"] as ChatSummary, messages = event["messages"] as ChatMessage[];
      const fromRestaurant = messages.filter((m) => m.author === "customer");
      if (!fromRestaurant.length) return;
      const watching = pathRef.current === `/chats/${chat.id}` && document.visibilityState === "visible";
      if (watching) return;
      chime();
      notify(`${chat.customer.name}${chat.status === "waiting" && messages.length === fromRestaurant.length && chat.lastMessage ? " needs help" : ""}`,
        fromRestaurant.at(-1)!.body.slice(0, 140), () => navigate(`/chats/${chat.id}`));
    });
    return () => { clearInterval(timer); off(); };
  }, [enabled]);
  return waiting;
}

export { MODE_NAMES };
