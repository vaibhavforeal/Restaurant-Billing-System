import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The restaurant's support chat page, served by the licensing Worker under /support/ (dist/support beside dist/portal).
// A page of its own, so restaurants never load the staff portal.
const worker = process.env["PORTAL_WORKER_URL"] ?? "http://127.0.0.1:8799";

export default defineConfig({
  root: "support",
  base: "/support/",
  publicDir: false,
  plugins: [react()],
  build: { outDir: "../dist/support", emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    proxy: {
      "/support/api": { target: worker, changeOrigin: true, headers: { origin: worker } },
      "/support/start": { target: worker, changeOrigin: true },
      "/support/live": { target: worker.replace(/^http/, "ws"), ws: true, changeOrigin: true, headers: { origin: worker } },
    },
  },
});
