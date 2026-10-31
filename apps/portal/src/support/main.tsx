// The restaurant's support chat, opened by MasalaPOS's Get support button. Plain and phone-friendly: say who you are once, then chat.
// Messages are sent over HTTP; the live socket brings replies at once, and the page checks every few seconds when it is down.
import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import type { VisitorChat, VisitorMessage } from "../../../licensing-worker/src/portal/api-types";
import { LiveConnection, type LiveEvent } from "../live-socket";
import "./support.css";

type Loaded = VisitorChat & { live: boolean };
type State = { kind: "loading" } | { kind: "expired" } | { kind: "error"; message: string } | { kind: "ready"; data: Loaded };

class Refused extends Error { constructor(readonly status: number, message: string, readonly code?: string) { super(message); } }

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/support/api${path}`, { ...init, credentials: "same-origin", headers: init.body ? { "content-type": "application/json" } : {}, signal: AbortSignal.timeout(20_000) });
  } catch { throw new Refused(0, "Couldn't reach MasalaPOS support. Check the internet connection and try again."); }
  const body = await res.json().catch(() => null) as ({ error?: string; code?: string } & T) | null;
  if (!res.ok) throw new Refused(res.status, body?.error ?? "Something went wrong. Try again.", body?.code);
  return body as T;
}

const live = new LiveConnection("/support/live");
const NAME_KEY = "masalapos-support-name", PHONE_KEY = "masalapos-support-phone";
const stored = (key: string) => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

const time = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });

function merge(list: VisitorMessage[], more: VisitorMessage[]): VisitorMessage[] {
  const seen = new Set(list.map((m) => m.id));
  return [...list, ...more.filter((m) => !seen.has(m.id))].sort((a, b) => a.id - b.id);
}

function App() {
  const [state, setState] = useState<State>(() => new URLSearchParams(location.search).get("link") === "expired" ? { kind: "expired" } : { kind: "loading" });
  const [connected, setConnected] = useState(false);
  const [typing, setTyping] = useState<{ name: string; until: number } | null>(null);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try { const data = await call<Loaded>("/chat"); setState((s) => s.kind === "ready" && s.data.chat && data.chat?.id === s.data.chat.id
      ? { kind: "ready", data: { ...data, chat: { ...data.chat, messages: merge(s.data.chat.messages, data.chat.messages) } } } : { kind: "ready", data }); }
    catch (e) { setState(e instanceof Refused && e.status === 401 ? { kind: "expired" } : { kind: "error", message: e instanceof Error ? e.message : "Couldn't load the chat." }); }
  }, []);

  useEffect(() => {
    if (state.kind === "expired") return;
    void load();
    live.start();
    const offStatus = live.onStatus(setConnected);
    const off = live.subscribe((event: LiveEvent) => {
      if (event.type === "visitor.updated") {
        const messages = event["messages"] as VisitorMessage[];
        setState((s) => {
          if (s.kind !== "ready") return s;
          const chat = s.data.chat;
          // A different (new) chat: reload it whole.
          if (!chat || chat.id !== event["chatId"]) { void load(); return s; }
          return { kind: "ready", data: { ...s.data, chat: { ...chat, status: event["status"] as typeof chat.status, agentName: (event["agentName"] as string | null) ?? chat.agentName,
            messages: merge(chat.messages, messages) } } };
        });
        if (messages.some((m) => m.author === "staff")) { setTyping(null); if (document.visibilityState !== "visible") setUnread((n) => n + 1); }
      } else if (event.type === "typing") setTyping({ name: String(event["name"] ?? "Support"), until: Date.now() + 5_000 });
    });
    return () => { off(); offStatus(); live.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Without the live socket, check for replies every few seconds; with it, a slow safety check.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const timer = setInterval(() => void load(), connected ? 30_000 : 4_000);
    return () => clearInterval(timer);
  }, [connected, state.kind, load]);

  useEffect(() => {
    const seen = () => { if (document.visibilityState === "visible") setUnread(0); };
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, []);
  useEffect(() => { document.title = `${unread ? `(${unread}) ` : ""}MasalaPOS Support`; }, [unread]);
  const [, tick] = useState(0);
  useEffect(() => { if (!typing) return; const t = setTimeout(() => tick((n) => n + 1), typing.until - Date.now() + 50); return () => clearTimeout(t); }, [typing]);

  return <div className="page">
    <header className="top">
      <svg viewBox="0 0 32 32" aria-hidden="true" className="mark"><rect width="32" height="32" rx="8" fill="#b92335" />
        <path d="M11 8v7a3 3 0 0 0 3 3v6M11 8v5M14 8v5M17 8v5M21 8c-1.7 0-3 2-3 5s1.3 4 3 4v7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <div><strong>MasalaPOS Support</strong>{state.kind === "ready" && <span>{state.data.customerName} · {state.data.outletName}</span>}</div>
    </header>
    {state.kind === "loading" && <main className="card center"><p className="muted">Opening your support chat…</p></main>}
    {state.kind === "expired" && <main className="card center"><h1>This support link has expired</h1>
      <p className="muted">Links work once, for a short time. Open MasalaPOS and click <strong>Get support</strong> again.</p></main>}
    {state.kind === "error" && <main className="card center"><h1>Couldn't open the chat</h1><p className="muted">{state.message}</p>
      <button className="primary" onClick={() => { setState({ kind: "loading" }); void load(); }}>Try again</button></main>}
    {state.kind === "ready" && <Chat data={state.data} typing={typing && typing.until > Date.now() ? typing.name : null}
      onSent={(data) => setState({ kind: "ready", data })} onExpired={() => setState({ kind: "expired" })} />}
  </div>;
}

function Chat({ data, typing, onSent, onExpired }: { data: Loaded; typing: string | null; onSent: (data: Loaded) => void; onExpired: () => void }) {
  const chat = data.chat;
  const open = chat !== null && chat.status !== "closed";
  const [name, setName] = useState(() => chat?.visitorName ?? stored(NAME_KEY));
  const [phone, setPhone] = useState(() => stored(PHONE_KEY));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [chat?.messages.length, typing]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    if (!open && !name.trim()) { setError("Tell us your name first."); return; }
    setBusy(true); setError("");
    try {
      const sent = await call<Loaded>("/messages", { method: "POST", body: JSON.stringify({ body, ...(open ? {} : { name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) }) }) });
      if (!open) { remember(NAME_KEY, name.trim()); remember(PHONE_KEY, phone.trim()); }
      setText("");
      onSent(sent);
    } catch (err) {
      if (err instanceof Refused && err.status === 401) onExpired();
      else setError(err instanceof Error ? err.message : "Couldn't send. Try again.");
    } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); return; }
    if (open && Date.now() - lastTyping.current > 3_000) { lastTyping.current = Date.now(); live.send({ type: "typing" }); }
  };

  const status = !chat ? null : chat.status === "waiting" ? "Waiting for someone from support. It usually takes a few minutes; you can keep working and come back to this tab."
    : chat.status === "active" ? `You're chatting with ${chat.agentName ?? "MasalaPOS support"}.` : "This chat has ended. Write below to start a new one.";
  return <main className="card chat">
    {status && <p className={`status ${chat?.status ?? ""}`} role="status">{status}</p>}
    <div className="messages" aria-live="polite">
      {!chat && <div className="welcome"><h1>How can we help?</h1><p className="muted">Tell us what's going on. A MasalaPOS support person will answer here. Keep this tab open.</p></div>}
      <ol>
        {chat?.messages.map((m) => m.author === "system" ? <li key={m.id} className="msg system">{m.body}</li>
          : <li key={m.id} className={`msg ${m.author === "customer" ? "out" : "in"}`}>
            <div className="bubble">{m.body}</div>
            <div className="meta">{m.author === "staff" ? `${m.name ?? "Support"} · ` : ""}{time.format(m.createdAt)}</div>
          </li>)}
        {typing && <li className="msg in typing">{typing} is typing…</li>}
      </ol>
      <div ref={end} />
    </div>
    <form className="composer" onSubmit={(e) => void send(e)}>
      {!open && <div className="who">
        <label><span>Your name</span><input required maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} /></label>
        <label><span>Phone <em>(optional)</em></span><input type="tel" maxLength={20} autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={busy} /></label>
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <textarea rows={2} maxLength={2000} aria-label="Message" autoFocus placeholder={open ? "Write a message" : "Describe the problem, e.g. the KOT printer isn't printing"}
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} disabled={busy} />
        <button className="primary" disabled={busy || !text.trim()}>{open ? "Send" : "Start chat"}</button>
      </div>
    </form>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
