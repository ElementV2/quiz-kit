import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Served by apps/server under /apps/host/ (pages: see apps/server/src/http/app.ts).
export default defineConfig({
  base: "/apps/host/",
  plugins: [solid()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: true },
});
