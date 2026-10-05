import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { captainPwa } from "./captain-pwa-plugin.ts";
import { kitchenPwa } from "./kitchen-pwa-plugin.ts";

export default defineConfig({
  plugins: [react(), captainPwa(), kitchenPwa()],
  server: {
    proxy: { "/api": { target: "http://localhost:4100", ws: true } },
  },
});
