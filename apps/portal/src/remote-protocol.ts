// What the viewer (portal) and the sharing window (MasalaPOS desktop) say to each other. Signalling travels through the portal's live hub;
// input and screen lists travel on the WebRTC data channel "input". The desktop app keeps its own copy of these shapes
// (apps/desktop/src/remote/protocol.ts); change both together.

/** Through the hub (remote.signal). The sharing window always makes the offer: it has the screen. */
export type Signal =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

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
