import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Served by apps/server under /apps/control/ (pages: see apps/server/src/http/app.ts).
export default defineConfig({
  base: "/apps/control/",
  plugins: [solid()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: true },
});
