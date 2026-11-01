// The sharing window's only door to the main process: its session's settings, the viewer's input (checked again in main), screens, state.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("remoteAgent", {
  send: (message: unknown) => ipcRenderer.send("remote:send", message),
  onEvent: (listener: (message: unknown) => void) => { ipcRenderer.on("remote:event", (_e, message: unknown) => listener(message)); ipcRenderer.send("remote:transport-ready"); },
  config: () => ipcRenderer.invoke("remote:config"),
  screens: () => ipcRenderer.invoke("remote:screens"),
  chooseScreen: (index: number) => ipcRenderer.invoke("remote:choose-screen", index),
  input: (message: unknown) => ipcRenderer.send("remote:input", message),
  state: (state: "sharing" | "stopped", reason?: string) => ipcRenderer.send("remote:state", state, reason),
  onMode: (listener: (mode: "view" | "control") => void) => { ipcRenderer.on("remote:mode", (_event, mode: "view" | "control") => listener(mode)); },
});
