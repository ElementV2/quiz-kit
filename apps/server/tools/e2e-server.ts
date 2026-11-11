import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_ALLOCATION_GAME, DEMO_GAME, DEMO_NUMBER_GAME, DEMO_ORDER_GAME, DEMO_PAIRS_GAME, DEMO_TEXT_GAME } from "@quiz/schema";
import { Config } from "../src/config.ts";
import { GameLibrary } from "../src/media/library.ts";
import { startServer } from "../src/server.ts";

/** Fresh server for Playwright (`e2e/`): temp journal, demo game, links written to E2E_LINKS. */
const port = Number(process.env["E2E_PORT"] ?? 7320);
const dataDir = mkdtempSync(join(tmpdir(), "quiz-e2e-"));
// Small fixed games the tests play (the built-in templates evolve; these do not).
const library = new GameLibrary(dataDir);
for (const [id, game] of [
  ["g_e2e_qcm", { ...DEMO_GAME, title: "E2E — QCM (3 questions)" }],
  ["g_e2e_live", { ...DEMO_GAME, title: "E2E — édité en direct" }], // studio-live writes to it: never shared
  ["g_e2e_texte", DEMO_TEXT_GAME],
  ["g_e2e_estimation", DEMO_NUMBER_GAME],
  ["g_e2e_ordre", DEMO_ORDER_GAME],
  ["g_e2e_paires", DEMO_PAIRS_GAME],
  ["g_e2e_repartition", DEMO_ALLOCATION_GAME],
] as const) library.put(id, game);
const server = await startServer({ ...Config.parse({ dataDir, logLevel: "warn", seats: 4, newSession: "1" }), port });
const out = process.env["E2E_LINKS"];
if (out !== undefined) {
  const res = await fetch(`http://127.0.0.1:${port}/api/links?t=${server.links.entries.find((e) => e.id === "control")?.path.split("t=")[1] ?? ""}`);
  writeFileSync(out, JSON.stringify(await res.json()));
}
process.stdout.write(`e2e server ready on ${port}\n`);
