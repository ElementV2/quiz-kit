import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Home page of the show server (`/`): served by apps/server under /apps/hub/.
export default defineConfig({
  base: "/apps/hub/",
  plugins: [solid()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: true },
});
