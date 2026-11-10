import { loadConfig } from "./config.ts";
import { formatLinks } from "./links.ts";
import { startServer } from "./server.ts";

/** Show-machine entry point: `pnpm start` (ADR-0006: an autonomous process, no dev shell needed). */
const config = loadConfig(process.env);
const server = await startServer(config);
process.stdout.write(formatLinks(server.links));

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
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
