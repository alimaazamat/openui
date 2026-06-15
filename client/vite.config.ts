import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 6969,
    proxy: {
      "/api": {
        target: "http://localhost:6968",
        changeOrigin: true,
      },
      // NOTE: /ws is intentionally not proxied. Vite's http-proxy cannot relay
      // Bun.serve's WebSocket upgrade response, so the client connects directly
      // to the backend in dev (see Terminal.tsx).
    },
  },
  build: {
    outDir: "dist",
  },
});
