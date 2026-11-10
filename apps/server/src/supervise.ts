import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * `pnpm start` — keeps the show server alive (doc 05 "superviseur relance"). If the server process dies for any
 * reason it is restarted at once; state comes back from the journal and clients reconnect by themselves.
 * Phase 4: the Tauri launcher takes over this role (ADR-0006).
 */
const entry = join(import.meta.dirname, "main.ts");
let restarts = 0;
let stopping = false;
let child: ReturnType<typeof spawn> | null = null;

function start(): void {
  const startedAt = Date.now();
  child = spawn(process.execPath, [entry], { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) process.exit(0);
    // Back off only if it crashes in a loop (bad config, port taken…).
    restarts = Date.now() - startedAt > 10_000 ? 0 : restarts + 1;
    const delay = Math.min(5000, 250 * 2 ** Math.min(restarts, 5));
    process.stderr.write(`\n[superviseur] serveur arrêté (code ${code ?? "-"}, signal ${signal ?? "-"}) : relance dans ${delay} ms\n`);
    setTimeout(start, delay);
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    if (child === null) process.exit(0);
    child.kill(sig);
  });
}
start();
