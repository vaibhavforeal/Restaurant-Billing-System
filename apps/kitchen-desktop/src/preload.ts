import { contextBridge, ipcRenderer } from "electron";
declare const location: { protocol: string };

if (location.protocol === "file:") contextBridge.exposeInMainWorld("kitchenConnection", {
  savedAddress: () => ipcRenderer.invoke("kitchen:address"),
  connect: (address: string) => ipcRenderer.invoke("kitchen:connect", address),
});
