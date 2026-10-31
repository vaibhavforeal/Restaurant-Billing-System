// The POS window's preload: tells the POS UI that it is the desktop app's own window on this PC, so it (and no browser or tablet on
// the network) shows MasalaPOS support's remote-access requests for consent. Nothing else crosses over.
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("masalaposDesktop", { remoteSupport: true });
