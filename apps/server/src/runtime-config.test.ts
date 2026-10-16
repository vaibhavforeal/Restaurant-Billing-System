import { expect, it } from "vitest";
import { join, resolve } from "node:path";
import { runtimeConfig } from "./runtime-config.js";

it("keeps existing desktop and development runtime defaults", () => {
  expect(runtimeConfig({}, "C:/bundle/server")).toMatchObject({ service: false, host: "0.0.0.0", port: 4100, dataDir: resolve("./data"), requireHttps: false });
});

it('requires explicit persistent storage and UI for hosted POS behind an HTTPS gateway',()=>{
 const env={FORKFLOW_RUNTIME:'hosted-pos',FORKFLOW_DATA_DIR:resolve('test-persistent-data'),FORKFLOW_UI_DIR:resolve('test-ui')};
 expect(runtimeConfig(env,'.')).toMatchObject({service:false,hosted:true,host:'0.0.0.0',port:4100,requireHttps:false,dataDir:env.FORKFLOW_DATA_DIR,uiDir:env.FORKFLOW_UI_DIR});
 expect(()=>runtimeConfig({FORKFLOW_RUNTIME:'hosted-pos'},'.')).toThrow(/storage/);
 expect(()=>runtimeConfig({...env,FORKFLOW_DATA_DIR:'./data'},'.')).toThrow(/absolute/);
 expect(()=>runtimeConfig({...env,FORKFLOW_UI_DIR:''},'.')).toThrow(/UI/);
});

it("runs the new browser POS preview with isolated data and the existing UI", () => {
  const config = runtimeConfig({ FORKFLOW_RUNTIME: "browser-preview" }, "C:/repo/apps/server/src");
  expect(config).toMatchObject({ service: false, host: "127.0.0.1", port: 4110, requireHttps: false });
  expect(config.dataDir).toBe(resolve("./.forkflow/browser-outlet"));
  expect(config.uiDir).toBe(resolve("C:/repo/apps/ui/dist"));
  expect(() => runtimeConfig({ FORKFLOW_RUNTIME: "browser-preview", FORKFLOW_HOST: "0.0.0.0" }, ".")).toThrow(/loopback/);
});

it("isolates service data and binds unencrypted billing to loopback", () => {
  const config = runtimeConfig({ FORKFLOW_RUNTIME: "outlet-service", ProgramData: "C:/ProgramData" }, "C:/Program Files/ForkFlow Outlet/current/server");
  expect(config).toMatchObject({ service: true, host: "127.0.0.1", port: 4100, requireHttps: true });
  expect(config.dataDir).toBe(resolve("C:/ProgramData/ForkFlow/Outlet/data"));
  expect(config.uiDir).toBe(resolve("C:/Program Files/ForkFlow Outlet/current/ui"));
});

it.each(["0.0.0.0", "192.168.1.2"])("rejects service HTTP exposure at %s", (host) => {
  expect(() => runtimeConfig({ FORKFLOW_RUNTIME: "outlet-service", ProgramData: "C:/ProgramData", FORKFLOW_HOST: host }, ".")).toThrow(/loopback/);
});

it("requires absolute service storage and fixed transport ports", () => {
  const env = { FORKFLOW_RUNTIME: "outlet-service", ProgramData: "C:/ProgramData" };
  expect(() => runtimeConfig({ ...env, FORKFLOW_DATA_DIR: "./data" }, ".")).toThrow(/absolute/);
  expect(() => runtimeConfig({ ...env, FORKFLOW_PORT: "4101" }, ".")).toThrow(/4100/);
  expect(() => runtimeConfig({ ...env, FORKFLOW_DATA_DIR: join(resolve("."), "data") }, ".")).not.toThrow();
});

it.each(["0", "NaN", "65536", "4100.5", ""])("rejects invalid server port %j", (port) => {
  expect(() => runtimeConfig({ FORKFLOW_PORT: port }, ".")).toThrow(/PORT/);
});
