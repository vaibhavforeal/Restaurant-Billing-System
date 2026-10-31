// The remote viewer: the restaurant's screen as a video, with the mouse and keyboard passed through when the PC allowed control.
// Waits for the PC's answer first; everything stops when either side ends it or the restaurant presses Stop.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import type { RemoteSession, RemoteViewerSetup, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { api, post } from "../api";
import { dateTime } from "../format";
import { portalLive, useLiveConnected, useLiveEvent } from "../live";
import type { AgentMessage, InputMessage, Signal } from "../remote-protocol";
import { Link } from "../router";
import { LoadError, PageHead, Pill, useData, useRun } from "../ui";
import { MODE_NAMES, REMOTE_STATUS } from "./LiveChat";

const OPEN = new Set<RemoteSession["status"]>(["requested", "approved", "active"]);

export function RemoteViewer({ id }: { id: string; me: StaffUser }) {
  const { data, error, reload, setData } = useData(() => api<RemoteViewerSetup>(`/remote-sessions/${id}`), id);
  const connected = useLiveConnected();
  const session = data?.session;
  const [refused, setRefused] = useState(false);
  const { busy, run, status } = useRun();

  // Watching tells the hub this socket is the viewer; again after every reconnect.
  useEffect(() => { if (connected && session && OPEN.has(session.status)) portalLive.send({ type: "remote.watch", sessionId: id }); }, [connected, id, session?.status]);
  useLiveEvent((event) => {
    if (event.type === "remote.updated" && (event["session"] as RemoteSession).id === id) setData((current) => current && { ...current, session: event["session"] as RemoteSession });
    if (event.type === "remote.refused" && event["sessionId"] === id) setRefused(true);
  });

  if (error) return <><PageHead title="Remote session" back={<Link to="/chats">Live chat</Link>} /><LoadError message={error} retry={reload} /></>;
  if (!session || !data) return <PageHead title="Loading…" back={<Link to="/chats">Live chat</Link>} />;
  const [label, tone] = REMOTE_STATUS[session.status];
  const back = session.chatId ? <Link to={`/chats/${session.chatId}`}>Back to the chat</Link> : <Link to="/chats">Live chat</Link>;
  return <>
    <PageHead back={back} title={<>{session.customer?.name ?? "Restaurant"} <span className="muted">· {session.installation.name}</span></>}
      sub={<><Pill tone={tone}>{label}</Pill> {session.mode ? MODE_NAMES[session.mode] : `${MODE_NAMES[session.modeRequested]} asked`} · {session.reason}</>}
      actions={OPEN.has(session.status) && <button className="danger" disabled={busy} onClick={() => void run(async () => setData({ ...data, session: (await post<{ session: RemoteSession }>(`/remote-sessions/${id}/end`)).session }))}>End session</button>} />
    {status}
    {refused && <p className="notice negative" role="alert">Only the person who asked for this session (or an admin) can view it.</p>}
    {!connected && OPEN.has(session.status) && <p className="notice">Connecting to the portal's live service…</p>}
    {session.status === "requested" && <div className="remote-wait"><p><strong>Waiting for someone at the PC to allow access.</strong></p>
      <p className="muted">They see your name and reason on the MasalaPOS screen, and have a minute to answer. Ask them on the chat or phone to click Allow.</p></div>}
    {session.status === "approved" && <div className="remote-wait"><p><strong>Allowed by {session.approvedByName}. Starting screen sharing…</strong></p></div>}
    {session.status === "active" && connected && !refused && <Screen sessionId={id} mode={session.mode ?? "view"} iceServers={data.iceServers} />}
    {!OPEN.has(session.status) && <div className="remote-wait"><p><strong>{session.status === "denied" ? `Refused at the PC${session.approvedByName ? ` by ${session.approvedByName}` : ""}.`
      : session.status === "expired" ? "No one answered at the PC." : `Ended${session.endReason ? `: ${session.endReason}` : ""}.`}</strong></p>
      <p className="muted small">Asked {dateTime(session.requestedAt)}{session.startedAt ? ` · started ${dateTime(session.startedAt)}` : ""}{session.endedAt ? ` · ended ${dateTime(session.endedAt)}` : ""}</p></div>}
  </>;
}

/** The video and the input it captures. A new offer from the PC (after either side reconnects) replaces the connection. */
function Screen({ sessionId, mode: grantedMode, iceServers }: { sessionId: string; mode: "view" | "control"; iceServers: RTCIceServer[] }) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const [state, setState] = useState<"connecting" | "live" | "lost">("connecting");
  const [screens, setScreens] = useState<Extract<AgentMessage, { t: "screens" }> | null>(null);
  const [mode, setMode] = useState(grantedMode);
  const moveQueued = useRef<InputMessage | null>(null);
  /** Candidates that came before the offer was applied. */
  const early = useRef<RTCIceCandidateInit[]>([]);

  const signal = useCallback((data: Signal) => portalLive.send({ type: "remote.signal", sessionId, data }), [sessionId]);

  const answer = useCallback(async (offer: string) => {
    pc.current?.close();
    const peer = new RTCPeerConnection({ iceServers });
    pc.current = peer;
    peer.onicecandidate = (e) => { if (e.candidate) signal({ kind: "candidate", candidate: e.candidate.toJSON() }); };
    peer.ontrack = (e) => { if (video.current) { video.current.srcObject = e.streams[0] ?? new MediaStream([e.track]); void video.current.play().catch(() => {}); } };
    peer.onconnectionstatechange = () => {
      setState(peer.connectionState === "connected" ? "live" : peer.connectionState === "failed" || peer.connectionState === "disconnected" ? "lost" : "connecting");
      // Watching again makes the PC send a fresh offer.
      if (peer.connectionState === "failed") setTimeout(() => { if (pc.current === peer) portalLive.send({ type: "remote.watch", sessionId }); }, 2_000);
    };
    peer.ondatachannel = (e) => {
      channel.current = e.channel;
      e.channel.onmessage = (m) => {
        let message: AgentMessage;
        try { message = JSON.parse(String(m.data)) as AgentMessage; } catch { return; }
        if (message.t === "screens") setScreens(message);
        else if (message.t === "mode") setMode(message.mode);
      };
    };
    await peer.setRemoteDescription({ type: "offer", sdp: offer });
    for (const candidate of early.current.splice(0)) await peer.addIceCandidate(candidate).catch(() => {});
    const local = await peer.createAnswer();
    await peer.setLocalDescription(local);
    signal({ kind: "answer", sdp: local.sdp ?? "" });
  }, [iceServers, signal, sessionId]);

  useLiveEvent((event) => {
    if (event.type !== "remote.signal" || event["sessionId"] !== sessionId) return;
    const data = event["data"] as Signal;
    if (data.kind === "offer") { early.current = []; void answer(data.sdp).catch(() => setState("lost")); }
    else if (data.kind === "candidate") {
      if (pc.current?.remoteDescription) void pc.current.addIceCandidate(data.candidate).catch(() => {});
      else early.current.push(data.candidate);
    }
  });
  useEffect(() => () => { pc.current?.close(); pc.current = null; }, []);

  const sendInput = (message: InputMessage) => { if (mode === "control" && channel.current?.readyState === "open") channel.current.send(JSON.stringify(message)); };
  /** Where the pointer is on the shared screen, as fractions; null over the letterbox bars. */
  const position = (e: MouseEvent | WheelEvent): { x: number; y: number } | null => {
    const v = video.current;
    if (!v || !v.videoWidth) return null;
    const box = v.getBoundingClientRect(), scale = Math.min(box.width / v.videoWidth, box.height / v.videoHeight);
    const w = v.videoWidth * scale, h = v.videoHeight * scale, left = box.left + (box.width - w) / 2, top = box.top + (box.height - h) / 2;
    const x = (e.clientX - left) / w, y = (e.clientY - top) / h;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  };
  const onMove = (e: MouseEvent) => {
    const at = position(e);
    if (!at) return;
    // One move per frame is plenty.
    if (!moveQueued.current) requestAnimationFrame(() => { if (moveQueued.current) sendInput(moveQueued.current); moveQueued.current = null; });
    moveQueued.current = { t: "move", ...at };
  };
  const onButton = (e: MouseEvent, down: boolean) => {
    const at = position(e);
    if (!at) return;
    e.preventDefault();
    if (down) frame.current?.focus();
    sendInput({ t: "button", button: e.button === 2 ? 2 : e.button === 1 ? 1 : 0, down, ...at });
  };
  const onKey = (e: KeyboardEvent, down: boolean) => {
    if (mode !== "control") return;
    e.preventDefault();
    if (!e.repeat || down) sendInput({ t: "key", code: e.code, down });
  };
  const press = (...codes: string[]) => { for (const code of codes) sendInput({ t: "key", code, down: true }); for (const code of [...codes].reverse()) sendInput({ t: "key", code, down: false }); };

  return <div className="remote-screen">
    <div className="remote-toolbar">
      <Pill tone={state === "live" ? "positive" : state === "lost" ? "negative" : "warning"}>{state === "live" ? "Connected" : state === "lost" ? "Connection lost, retrying" : "Connecting"}</Pill>
      <span className="muted small">{mode === "control" ? "Your mouse and keyboard work on their PC. Click the screen first." : "View only: you can't click on their PC."}</span>
      <span className="spacer" />
      {screens && screens.screens.length > 1 && <select aria-label="Screen" value={screens.current} onChange={(e) => sendInput({ t: "screen", index: Number(e.target.value) })} disabled={mode !== "control"}>
        {screens.screens.map((s) => <option key={s.index} value={s.index}>{s.label} ({s.width}×{s.height})</option>)}</select>}
      {mode === "control" && <><button className="secondary small" onClick={() => press("MetaLeft")}>Start menu</button>
        <button className="secondary small" onClick={() => press("AltLeft", "Tab")}>Alt+Tab</button>
        <button className="secondary small" onClick={() => press("MetaLeft", "KeyD")}>Show desktop</button></>}
      <button className="secondary small" onClick={() => void frame.current?.requestFullscreen().catch(() => {})}>Full screen</button>
    </div>
    <div ref={frame} className={`remote-frame${mode === "control" ? " control" : ""}`} tabIndex={0} aria-label="The restaurant's screen"
      onMouseMove={onMove} onMouseDown={(e) => onButton(e, true)} onMouseUp={(e) => onButton(e, false)} onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => { if (position(e)) sendInput({ t: "wheel", dx: Math.sign(e.deltaX), dy: Math.sign(e.deltaY) }); }}
      onKeyDown={(e) => onKey(e, true)} onKeyUp={(e) => onKey(e, false)}>
      <video ref={video} muted playsInline autoPlay />
      {state !== "live" && <p className="remote-overlay muted">{state === "lost" ? "The connection dropped. Waiting for the PC to reconnect…" : "Starting the picture…"}</p>}
    </div>
  </div>;
}
