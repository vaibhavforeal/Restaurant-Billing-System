// Remote support messages between the POS server (which holds the counter's live connection to MasalaPOS) and the desktop shell
// (which shares the screen). The server only ever asks the shell to start a session someone at this PC has just allowed.

export type RemoteMode = "view" | "control";
export interface IceServer { urls: string[]; username?: string; credential?: string }

/** Server → desktop shell. */
export type RemoteToDesktop =
  /** Start sharing: `agentUrl` is the one-time wss:// address of the session's signalling socket. */
  | { type: "remote-start"; sessionId: string; agentUrl: string; mode: RemoteMode; iceServers: IceServer[]; agentName: string; maxMs: number }
  | { type: "remote-stop"; sessionId: string; reason: string };
/** Desktop shell → server. */
export type RemoteToServer =
  | { type: "remote-state"; sessionId: string; state: "sharing" | "stopped"; reason?: string }
  /** The restaurant pressed Stop on the sharing banner. */
  | { type: "remote-stop-request"; sessionId: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isMode = (v: unknown): v is RemoteMode => v === "view" || v === "control";

export function isRemoteToDesktop(value: unknown): value is RemoteToDesktop {
  if (!isObject(value) || typeof value["sessionId"] !== "string") return false;
  if (value["type"] === "remote-stop") return typeof value["reason"] === "string";
  return value["type"] === "remote-start" && typeof value["agentUrl"] === "string" && /^wss?:\/\//.test(value["agentUrl"]) && isMode(value["mode"])
    && Array.isArray(value["iceServers"]) && typeof value["agentName"] === "string" && typeof value["maxMs"] === "number";
}

export function isRemoteToServer(value: unknown): value is RemoteToServer {
  if (!isObject(value) || typeof value["sessionId"] !== "string") return false;
  return value["type"] === "remote-stop-request" || (value["type"] === "remote-state" && (value["state"] === "sharing" || value["state"] === "stopped"));
}
