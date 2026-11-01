// The sharing banner's buttons: Stop, and switching between view only and control (never more than the PC allowed).
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("remoteBanner", {
  stop: () => ipcRenderer.send("remote-banner:stop"),
  setViewOnly: (viewOnly: boolean) => ipcRenderer.send("remote-banner:view-only", viewOnly),
  onState: (listener: (state: { agentName: string; granted: "view" | "control"; viewOnly: boolean; sharing: boolean }) => void) => {
    ipcRenderer.on("remote-banner:state", (_event, state) => listener(state));
  },
});
