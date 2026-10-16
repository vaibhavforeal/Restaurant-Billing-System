import { isAbsolute, resolve } from "node:path";

/** Service mode is explicit so the established Electron/dev deployment keeps its contract. */
export function runtimeConfig(env: NodeJS.ProcessEnv, serverDirectory: string) {
  const service = env["FORKFLOW_RUNTIME"] === "outlet-service";
  const preview = env["FORKFLOW_RUNTIME"] === "browser-preview";
  const hosted = env["FORKFLOW_RUNTIME"] === "hosted-pos";
  if (hosted && !env["FORKFLOW_DATA_DIR"]) throw new Error("Hosted POS requires persistent storage");
  if (hosted && !env["FORKFLOW_UI_DIR"]) throw new Error("Hosted POS requires an explicit UI directory");
  const host = env["FORKFLOW_HOST"] ?? (service || preview ? "127.0.0.1" : "0.0.0.0");
  const port = Number(env["FORKFLOW_PORT"] ?? (preview ? 4110 : 4100));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid FORKFLOW_PORT");
  if (service && host !== "127.0.0.1") throw new Error("Outlet service HTTP must bind to IPv4 loopback");
  if (preview && host !== "127.0.0.1") throw new Error("Browser preview HTTP must bind to IPv4 loopback");
  if (service && port !== 4100) throw new Error("Outlet service HTTP must use port 4100");
  const dataPath = env["FORKFLOW_DATA_DIR"] ?? (service ? resolve(env["ProgramData"] ?? "C:/ProgramData", "ForkFlow/Outlet/data") : preview ? "./.forkflow/browser-outlet" : "./data");
  if ((service || hosted) && !isAbsolute(dataPath)) throw new Error("POS data directory must be absolute");
  return {
    service, hosted, host, port, dataDir: resolve(dataPath), requireHttps: service,
    uiDir: resolve(env["FORKFLOW_UI_DIR"] ?? resolve(serverDirectory, service ? "../ui" : "../../ui/dist")),
  };
}
