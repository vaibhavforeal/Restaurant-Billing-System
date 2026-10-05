import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { captainWorker } from "./captain-worker.ts";

export function captainPwa(): Plugin {
  let publicDir = "";
  return {
    name: "forkflow-captain-pwa", apply: "build", enforce: "post",
    configResolved(config) { publicDir = config.publicDir; },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter((file) => /\.(js|css)$/.test(file)).map((file) => "/" + file).sort();
      const hash = createHash("sha256").update(captainWorker("version", assets));
      for (const file of Object.keys(bundle).sort()) {
        const output = bundle[file]!;
        hash.update(file).update(output.type === "chunk" ? output.code : output.source);
      }
      for (const file of ["manifest.webmanifest", "icon-192.png", "icon-512.png"]) hash.update(readFileSync(resolve(publicDir, "captain", file)));
      const version = hash.digest("hex").slice(0, 16);
      this.emitFile({ type: "asset", fileName: "captain/sw.js", source: captainWorker(version, [...assets, "/captain/manifest.webmanifest", "/captain/icon-192.png", "/captain/icon-512.png"]) });
    },
  };
}
