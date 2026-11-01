import { contextBridge, ipcRenderer } from "electron";
import type { ConnectorBridge, ConnectorState } from "./contracts.js";
const bridge: ConnectorBridge = {
  state: () => ipcRenderer.invoke("connector:state"),
  consent: (input) => ipcRenderer.invoke("connector:consent", input),
  chat: (body) => ipcRenderer.invoke("connector:chat", body),
  stop: () => ipcRenderer.invoke("connector:stop"),
  viewOnly: (on) => ipcRenderer.invoke("connector:view-only", on),
  onState: (listener) => { const handler = (_e: unknown, state: ConnectorState) => listener(state); ipcRenderer.on("connector:state", handler); return () => { ipcRenderer.removeListener("connector:state", handler); }; },
};
contextBridge.exposeInMainWorld("connector", bridge);
