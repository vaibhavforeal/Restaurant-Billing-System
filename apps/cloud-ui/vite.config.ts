import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [react()], server: { host: "127.0.0.1", port: 4300, proxy: { "/v1": { target: "http://127.0.0.1:4200" } } } });
