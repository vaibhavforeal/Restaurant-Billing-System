import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { captainWorker } from "./captain-worker.ts";

export function kitchenPwa(): Plugin {
  let publicDir = "";
  return {
    name: "forkflow-kitchen-pwa", apply: "build", enforce: "post",
    configResolved(config) { publicDir = config.publicDir; },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter(file => /\.(js|css)$/.test(file) && !file.endsWith("sw.js")).map(file => "/" + file).sort();
      const manifest = JSON.stringify({ id: "/kitchen/", name: "ForkFlow Kitchen", short_name: "Kitchen", start_url: "/kitchen/", scope: "/kitchen/", display: "standalone", background_color: "#f6f7f9", theme_color: "#d12d3b", icons: [192, 512].map(size => ({ src: `/kitchen/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png" })) });
      this.emitFile({ type: "asset", fileName: "kitchen/manifest.webmanifest", source: manifest });
      const hash = createHash("sha256").update(manifest).update(captainWorker("version", assets, "kitchen"));
      for (const file of Object.keys(bundle).sort()) { const output = bundle[file]!; hash.update(file).update(output.type === "chunk" ? output.code : output.source); }
      for (const size of [192, 512]) {
        const source = readFileSync(resolve(publicDir, "captain", `icon-${size}.png`)); hash.update(source);
        this.emitFile({ type: "asset", fileName: `kitchen/icon-${size}.png`, source });
      }
      this.emitFile({ type: "asset", fileName: "kitchen/sw.js", source: captainWorker(hash.digest("hex").slice(0, 16), [...assets, "/kitchen/manifest.webmanifest", "/kitchen/icon-192.png", "/kitchen/icon-512.png"], "kitchen") });
    },
  };
}
