import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../src/config.ts";
import { startServer } from "../src/server.ts";

/** Fresh server for Playwright (`e2e/`): temp journal, demo game, links written to E2E_LINKS. */
const port = Number(process.env["E2E_PORT"] ?? 7320);
const dataDir = mkdtempSync(join(tmpdir(), "quiz-e2e-"));
const server = await startServer({ ...Config.parse({ dataDir, logLevel: "warn", seats: 4, newSession: "1" }), port });
const out = process.env["E2E_LINKS"];
if (out !== undefined) {
  const res = await fetch(`http://127.0.0.1:${port}/api/links?t=${server.links.entries.find((e) => e.id === "control")?.path.split("t=")[1] ?? ""}`);
  writeFileSync(out, JSON.stringify(await res.json()));
}
process.stdout.write(`e2e server ready on ${port}\n`);
