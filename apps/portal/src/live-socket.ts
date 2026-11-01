// A live socket to the portal host that reconnects on its own (1 s, 2 s, 4 s … up to 30 s). Used by the portal (/portal/api/live)
// and the restaurant's chat page (/support/live). Screens still load and send over HTTP; the socket only tells them something changed.

export type LiveEvent = { type: string } & Record<string, unknown>;
type Listener = (event: LiveEvent) => void;

export class LiveConnection {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(connected: boolean) => void>();
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  /** Set when the server refused us outright (signed out): no point retrying. */
  private refusedAt = 0;
  connected = false;

  constructor(private readonly path: string) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close(1000);
    this.socket = null;
    this.setConnected(false);
  }

  send(message: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onStatus(listener: (connected: boolean) => void): () => void { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    for (const listener of this.statusListeners) listener(value);
  }

  private open() {
    if (this.stopped) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${this.path}`;
    let socket: WebSocket;
    try { socket = new WebSocket(url); } catch { this.retry(); return; }
    this.socket = socket;
    const opened = Date.now();
    socket.onopen = () => { this.attempts = 0; this.setConnected(true); };
    socket.onmessage = (message) => {
      let event: LiveEvent;
      try { event = JSON.parse(String(message.data)) as LiveEvent; } catch { return; }
      for (const listener of this.listeners) listener(event);
    };
    socket.onclose = (close) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setConnected(false);
      // 4001: signed out on the server. A refused upgrade closes at once without opening: back off harder.
      if (close.code === 4001 || Date.now() - opened < 1000) this.refusedAt = Date.now();
      this.retry();
    };
  }

  private retry() {
    if (this.stopped) return;
    const base = Math.min(30_000, 1000 * 2 ** this.attempts++);
    const delay = Date.now() - this.refusedAt < 5_000 ? Math.max(base, 10_000) : base;
    this.timer = setTimeout(() => this.open(), delay + Math.random() * 500);
  }
}
