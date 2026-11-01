// What the viewer (portal) and the sharing window (MasalaPOS desktop) say to each other. A copy of apps/portal/src/remote-protocol.ts:
// signalling travels through the portal's live hub, input and screen lists on the WebRTC data channel "input".
// The two apps build separately; change both together.

/** Through the hub (remote.signal). The sharing window always makes the offer: it has the screen. */
export type Signal =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "candidate"; candidate: IceCandidate };

/** RTCIceCandidateInit, spelled out so this file needs no DOM types (the main process uses it too). */
export interface IceCandidate { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null }

/** Viewer to PC on the data channel. Positions are fractions (0 to 1) of the shared screen, so the PC maps them to its own pixels. */
export type InputMessage =
  | { t: "move"; x: number; y: number }
  | { t: "button"; button: 0 | 1 | 2; down: boolean; x: number; y: number }
  | { t: "wheel"; dx: number; dy: number }
  | { t: "key"; code: string; down: boolean }
  | { t: "screen"; index: number };

/** PC to viewer on the data channel. */
export type AgentMessage =
  | { t: "screens"; screens: Array<{ index: number; label: string; width: number; height: number }>; current: number }
  | { t: "mode"; mode: "view" | "control" };
