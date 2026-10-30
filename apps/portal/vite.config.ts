import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by the licensing Worker under /portal/. The build goes into dist/portal so the files sit at the paths the Worker's
// static assets serve (assets.directory is apps/portal/dist).
const worker = process.env["PORTAL_WORKER_URL"] ?? "http://127.0.0.1:8799";

export default defineConfig({
  base: "/portal/",
  plugins: [react()],
  build: { outDir: "dist/portal", emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    // `wrangler dev --port 8799` runs the Worker (8787 is taken on the build PC). The Worker only accepts changes whose Origin is its
    // own, so the proxy presents the Worker's origin.
    proxy: { "/portal/api": { target: worker, changeOrigin: true, headers: { origin: worker } } },
  },
});
