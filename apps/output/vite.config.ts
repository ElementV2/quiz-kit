import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Served by apps/server under /apps/output/ (pages: see apps/server/src/http/app.ts).
export default defineConfig({
  base: "/apps/output/",
  plugins: [solid()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: true, chunkSizeWarningLimit: 700 }, // PixiJS chunk (~620 kB) is lazy: loaded only when ?fx≠off
});
