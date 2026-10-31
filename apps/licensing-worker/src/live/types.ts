// The live (push) side of support: who may hold a socket open to the service, and what the HTTP routes may push to them.
// Host-neutral: apps/licensing-node runs the hub over the `ws` package; a Cloudflare host would need a Durable Object adapter.
import type { StaffUser } from "../portal/api-types.js";

/** One open socket, as the host gives it to the hub. Text frames only. */
export interface LiveSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** Who is on the other end of a socket, decided once when it opens (see authorize.ts). */
export type Peer =
  /** A signed-in staff member in the portal (Live chat, the remote viewer). */
  | { kind: "staff"; user: StaffUser; tokenHash: string }
  /** The restaurant's browser, holding the session a counter's support link turned into. */
  | { kind: "visitor"; installationId: string; sessionHash: string }
  /** A counter's POS server, authenticated with its installation secret. Carries remote-access requests to the PC. */
  | { kind: "counter"; installationId: string; customerId: string }
  /** The screen-sharing window on the restaurant's PC during one approved remote session. */
  | { kind: "agent"; sessionId: string; installationId: string };

export interface Connection {
  onMessage(text: string): void;
  onClose(): void;
}

/** A message pushed to a socket. `type` says what it is; the rest is the payload. */
export type LiveEvent = { type: string } & Record<string, unknown>;

/** What the HTTP routes need from the hub. Absent (env.LIVE undefined) on hosts without live sockets: chat still works by polling. */
export interface LiveHub {
  connect(peer: Peer, socket: LiveSocket): Connection;
  /** To the restaurant's open chat pages for this counter. */
  toVisitors(installationId: string, event: LiveEvent): void;
  /** To every staff member who can see support chats. */
  toStaff(event: LiveEvent): void;
  /** To the counter's POS server; false when it is not connected. */
  toCounter(installationId: string, event: LiveEvent): boolean;
  counterOnline(installationId: string): boolean;
  /** To everyone taking part in a remote session: the staff who asked, and the sharing window. */
  toRemote(sessionId: string, event: LiveEvent): void;
  /** Closes a remote session's sharing window, if it is connected. */
  dropAgent(sessionId: string): void;
}
