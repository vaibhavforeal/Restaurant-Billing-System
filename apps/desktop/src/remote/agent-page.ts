// The hidden sharing window of one remote session. Connects to the session's signalling socket with its one-time address, captures the
// chosen screen, and offers it to the viewer over WebRTC whenever a viewer is (re)connected. Input from the viewer goes to the main
// process, which decides whether to act on it. When the socket closes, the session is over.
import type { AgentMessage, Signal } from "./protocol.js";

interface Config { agentUrl: string; iceServers: RTCIceServer[]; mode: "view" | "control"; agentName: string }
interface ScreenList { screens: Array<{ index: number; label: string; width: number; height: number }>; current: number }
declare global {
  interface Window {
    remoteAgent: {
      config(): Promise<Config>;
      screens(): Promise<ScreenList>;
      chooseScreen(index: number): Promise<ScreenList>;
      input(message: unknown): void;
      state(state: "sharing" | "stopped", reason?: string): void;
      onMode(listener: (mode: "view" | "control") => void): void;
    };
  }
}

/** With no viewer for this long (support closed the page), the session ends. */
const VIEWER_GONE_MS = 2 * 60_000;
const bridge = window.remoteAgent;
let pc: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let stream: MediaStream | null = null;
let mode: "view" | "control" = "view";
let goneTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
const early: RTCIceCandidateInit[] = [];

function stop(reason: string) {
  if (stopped) return;
  stopped = true;
  pc?.close();
  for (const track of stream?.getTracks() ?? []) track.stop();
  bridge.state("stopped", reason);
}

async function capture(): Promise<MediaStream> {
  // The main process answers with the chosen screen (setDisplayMediaRequestHandler); no picker is shown.
  // Electron's capture takes no size or rate constraints up front; they are applied to the track instead.
  const next = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const track = next.getVideoTracks()[0];
  if (track) {
    track.contentHint = "detail"; // text stays sharp; motion matters less
    await track.applyConstraints({ frameRate: { max: 15 }, width: { max: 1920 }, height: { max: 1080 } }).catch(() => {});
  }
  return next;
}

function sendToViewer(message: AgentMessage) { if (channel?.readyState === "open") channel.send(JSON.stringify(message)); }

async function main() {
  const config = await bridge.config();
  mode = config.mode;
  stream = await capture();
  stream.getVideoTracks()[0]?.addEventListener("ended", () => stop("Screen capture stopped"));
  bridge.onMode((next) => { mode = next; sendToViewer({ t: "mode", mode }); });

  const ws = new WebSocket(config.agentUrl);
  const signal = (data: Signal) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "remote.signal", data })); };

  async function offer() {
    pc?.close();
    early.length = 0;
    const peer = new RTCPeerConnection({ iceServers: config.iceServers });
    pc = peer;
    for (const track of stream!.getTracks()) peer.addTrack(track, stream!);
    const dc = peer.createDataChannel("input", { ordered: true });
    channel = dc;
    dc.onopen = () => { void bridge.screens().then((list) => sendToViewer({ t: "screens", ...list })); sendToViewer({ t: "mode", mode }); };
    dc.onmessage = (event) => {
      let message: unknown;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (typeof message === "object" && message !== null && (message as { t?: unknown }).t === "screen") void switchScreen((message as { index: number }).index);
      else bridge.input(message);
    };
    peer.onicecandidate = (event) => { if (event.candidate) signal({ kind: "candidate", candidate: event.candidate.toJSON() }); };
    const description = await peer.createOffer();
    await peer.setLocalDescription(description);
    // About 2.5 Mbit/s is plenty for a POS screen and keeps a relayed session light.
    for (const sender of peer.getSenders()) {
      const parameters = sender.getParameters();
      parameters.encodings = (parameters.encodings?.length ? parameters.encodings : [{}]).map((e) => ({ ...e, maxBitrate: 2_500_000 }));
      await sender.setParameters(parameters).catch(() => {});
    }
    signal({ kind: "offer", sdp: description.sdp ?? "" });
  }

  async function switchScreen(index: number) {
    if (mode !== "control") return;
    const list = await bridge.chooseScreen(index);
    const next = await capture();
    const track = next.getVideoTracks()[0];
    if (!track) return;
    for (const sender of pc?.getSenders() ?? []) if (sender.track?.kind === "video") await sender.replaceTrack(track);
    for (const old of stream?.getTracks() ?? []) old.stop();
    stream = next;
    track.addEventListener("ended", () => stop("Screen capture stopped"));
    sendToViewer({ t: "screens", ...list });
  }

  ws.onopen = () => bridge.state("sharing");
  ws.onclose = () => stop("The connection to MasalaPOS support ended");
  ws.onmessage = (event) => {
    let message: { type?: string; data?: Signal; session?: { status?: string } };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.type === "remote.peer") {
      if (goneTimer) { clearTimeout(goneTimer); goneTimer = null; }
      void offer().catch(() => {});
    } else if (message.type === "remote.peer-left") {
      goneTimer ??= setTimeout(() => { stop("Support closed the viewer"); ws.close(); }, VIEWER_GONE_MS);
    } else if (message.type === "remote.updated" && message.session?.status === "ended") {
      stop("Support ended the session");
      ws.close();
    } else if (message.type === "remote.signal" && message.data && pc) {
      const data = message.data;
      if (data.kind === "answer") {
        void pc.setRemoteDescription({ type: "answer", sdp: data.sdp }).then(async () => { for (const c of early.splice(0)) await pc?.addIceCandidate(c).catch(() => {}); }).catch(() => {});
      } else if (data.kind === "candidate") {
        if (pc.remoteDescription) void pc.addIceCandidate(data.candidate).catch(() => {});
        else early.push(data.candidate);
      }
    }
  };
}

main().catch((error: unknown) => stop(error instanceof Error ? `Screen sharing couldn't start: ${error.message}` : "Screen sharing couldn't start"));
