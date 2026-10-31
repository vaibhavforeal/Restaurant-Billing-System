// The Worker's ASSETS binding over a directory: serves the built portal (apps/portal/dist, whose files live under /portal/).
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { AssetsBinding } from "../../licensing-worker/src/env.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

export function directoryAssets(root: string): AssetsBinding {
  const base = resolve(root);
  return {
    async fetch(request) {
      let path: string;
      try { path = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response("Not found", { status: 404 }); }
      if (path.includes("\0")) return new Response("Not found", { status: 404 });
      let file = resolve(base, `.${path}`);
      // A path that climbs out of the root (../) never reaches the file system.
      if (file !== base && !file.startsWith(base + sep)) return new Response("Not found", { status: 404 });
      try {
        if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
        const body = await readFile(file);
        return new Response(request.method === "HEAD" ? null : body, { headers: { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" } });
      } catch { return new Response("Not found", { status: 404 }); }
    },
  };
}
