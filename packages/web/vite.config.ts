import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The workbench is served by the local Fastify server in production builds
 * (`packages/server` mounts `packages/web/dist`). During development Vite owns
 * the page and proxies `/api` to the loopback server, including SSE streams.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3210",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
  },
});
