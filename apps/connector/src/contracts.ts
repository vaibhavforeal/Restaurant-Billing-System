import type { RemoteSession, VisitorMessage } from "../../licensing-worker/src/portal/api-types.js";
export interface ConnectorState { session: RemoteSession | null; elevated: boolean; sharing: boolean; ended: boolean; viewOnly: boolean; error: string | null; messages: VisitorMessage[] }
export interface ConsentInput { mode: "view" | "control" | "deny"; approvedBy: string; adminPrompts: boolean }
export interface ConnectorBridge {
  state(): Promise<ConnectorState>;
  consent(input: ConsentInput): Promise<void>;
  chat(body: string): Promise<void>;
  stop(): Promise<void>;
  viewOnly(on: boolean): Promise<void>;
  onState(listener: (state: ConnectorState) => void): () => void;
}
