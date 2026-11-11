import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { formatLinks } from "./links.ts";
import { startServer } from "./server.ts";

/** Show-machine entry point: `pnpm start` (ADR-0006: an autonomous process, no dev shell needed). */
const config = loadConfig(process.env);
const server = await startServer(config);
process.stdout.write(formatLinks(server.links, join(server.dataDir, "links.txt"), process.stdout.isTTY));

let stopping = false;
const stop = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  server.http.log.info({ signal }, "arrêt propre");
  server.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
// Last resort: a bug escaping every guard. Exit so the supervisor restarts from the journal (state is durable).
process.on("uncaughtException", (err) => {
  server.http.log.fatal({ err }, "exception non rattrapée : redémarrage par le superviseur");
  process.exit(1);
});
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

// Desktop launcher (ADR-0014): if the launcher dies without stopping us (crash, killed), stop cleanly too —
// never an orphan server holding the port and the journal.
const parent = Number(process.env["QUIZ_PARENT_PID"]);
if (Number.isInteger(parent) && parent > 0) {
  const alive = (): boolean => {
    try {
      process.kill(parent, 0);
      return true;
    } catch (err) {
      return typeof err === "object" && err !== null && "code" in err && err.code === "EPERM"; // exists, not ours
    }
  };
  setInterval(() => {
    if (!alive()) stop("parent-exit");
  }, 2000).unref();
}
