import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { Plugin as PostCssPlugin } from "postcss";
import { defineConfig } from "vite";
import { captainPwa } from "./captain-pwa-plugin.ts";
import { kitchenPwa } from "./kitchen-pwa-plugin.ts";

/** BoardUI sizes everything in rem, assuming 16px. The POS sets html { font-size: 13px }, which would shrink every
 * BoardUI control by 19%. Rewriting rem to px in the dashboard stylesheet keeps BoardUI's intended sizes without touching
 * the POS root size. A PostCSS step so it runs in dev and in the production build. */
const boardRemToPx: PostCssPlugin = {
  postcssPlugin: "boardui-rem-to-px",
  Once(root, { result }) {
    if (!/[\/]boardui\.css(\?|$)/.test(result.opts.from ?? "")) return;
    root.walkDecls((decl) => {
      decl.value = decl.value.replace(/(-?\d*\.?\d+)rem(?![a-z-])/g, (_, n: string) => `${Math.round(Number(n) * 16 * 1000) / 1000}px`);
    });
  },
};

export default defineConfig({
  // Tailwind only processes the dashboard's own stylesheet (no preflight); see src/dynamic-dashboard/boardui.css.
  plugins: [tailwindcss(), react(), captainPwa(), kitchenPwa()],
  css: { postcss: { plugins: [boardRemToPx] } },
  resolve: {
    alias: { "@board": fileURLToPath(new URL("./src/dynamic-dashboard/boardui", import.meta.url)) },
  },
  server: {
    proxy: { "/api": { target: "http://localhost:4100", ws: true } },
  },
});
