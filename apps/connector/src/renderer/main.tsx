import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectorBridge, ConnectorState } from "../contracts.js";
import "./style.css";
declare global { interface Window { connector: ConnectorBridge } }
function App() {
  const [state,setState] = useState<ConnectorState | null>(null), [name,setName] = useState(""), [admin,setAdmin] = useState(false), [reply,setReply] = useState(""), [busy,setBusy] = useState(false), [error,setError] = useState<string | null>(null);
  useEffect(() => { const off = window.connector.onState(setState); void window.connector.state().then(setState); return off; },[]);
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch(e) { setError(e instanceof Error ? e.message : "Please try again"); } finally { setBusy(false); } };
  const session = state?.session;
  const consent = (mode: "view" | "control" | "deny") => act(() => window.connector.consent({ mode, approvedBy: name.trim() || "Person at the PC", adminPrompts: mode === "deny" ? false : admin }));
  return <main><header><span className="mark">M</span><div><strong>MasalaPOS</strong><span>Support Connector</span></div><small>{state?.elevated ? "Administrator" : "Connecting"}</small></header>
    {(error || state?.error) && <p className="error" role="alert">{error || state?.error}</p>}
    {!state || !session ? <section><h1>{state?.ended ? "Unable to connect" : "Opening your invitation…"}</h1><p>Return to your support chat for a new connector link if this invitation is unavailable.</p></section>
      : state.ended ? <section><span className="eyebrow">SESSION ENDED</span><h1>Screen sharing has stopped.</h1><p>Support can no longer view or control this PC. You can close this window.</p></section>
      : session.status === "requested" ? <section><span className="eyebrow">YOUR PERMISSION, EVERY TIME</span><h1>{session.requestedBy.name} wants to {session.modeRequested === "control" ? "view and control" : "view"} this PC.</h1>
        <p>{session.customer?.name} {session.installation ? `· ${session.installation.name}` : ""}</p><blockquote>{session.reason}</blockquote>
        <p>Only allow access if you contacted MasalaPOS support. A red border remains visible while sharing. You can switch to view only or stop at any time.</p>
        <label>Your name<input maxLength={80} value={name} onChange={(e)=>setName(e.target.value)} autoFocus /></label>
        <label className="check"><input type="checkbox" checked={admin} disabled={!state.elevated || busy} onChange={(e)=>setAdmin(e.target.checked)}/><span>Allow support through Windows admin prompts<small>Temporarily shows Windows administrator prompts on this desktop. The previous Windows setting is restored when sharing ends.</small></span></label>
        <div className="actions"><button disabled={busy} onClick={()=>void consent("deny")}>Decline</button><button disabled={busy} onClick={()=>void consent("view")}>View only</button>{session.modeRequested === "control" && <button className="primary" disabled={busy} onClick={()=>void consent("control")}>Allow control</button>}</div>
      </section> : <section><span className="eyebrow">{state.sharing ? "YOU ARE SHARING YOUR SCREEN" : "CONNECTING TO SUPPORT"}</span><h1>{session.requestedBy.name} from MasalaPOS</h1>
        <div className="actions"><span>{state.viewOnly ? "View only" : "View and control"}</span>{session.mode === "control" && <button onClick={()=>void act(()=>window.connector.viewOnly(!state.viewOnly))}>{state.viewOnly ? "Allow control" : "View only"}</button>}<button className="danger" onClick={()=>void window.connector.stop()}>Stop sharing</button></div>
        <ol className="messages" aria-live="polite">{state.messages.map((m)=><li key={m.id} className={m.author}><small>{m.author === "customer" ? "You" : m.name ?? "MasalaPOS"}</small><p>{m.body}</p></li>)}</ol>
        <form onSubmit={(e)=>{e.preventDefault();void act(async()=>{await window.connector.chat(reply);setReply("");});}}><label>Message support<textarea value={reply} maxLength={2000} onChange={(e)=>setReply(e.target.value)} rows={2}/></label><button className="primary" disabled={busy || !reply.trim()}>Send</button></form>
      </section>}
    <footer>One session. Your permission. Stop at any time.</footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
