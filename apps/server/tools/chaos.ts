import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { defaultRegistry, project, replay } from "@quiz/engine";
import type { QuizClient } from "@quiz/protocol";
import type { Action } from "@quiz/schema";
import { SqliteEventStore } from "../src/store/sqlite-event-store.ts";
import { Bot } from "./bot.ts";
import { bigGame, connect, drive, isOpen, sleep, spawnServer, tokens, until, type ServerProcess } from "./harness.ts";

/**
 * pnpm chaos — phase 0 exit criterion (doc 05): kill the server, cut the network, reload an output
 * in the middle of questions → the final state must be identical and no acknowledged answer lost.
 */
const PLAYERS = Number(process.env["CHAOS_PLAYERS"] ?? 50);
const QUESTIONS = 10;
const PORT = Number(process.env["CHAOS_PORT"] ?? 7311);

const dataDir = mkdtempSync(join(tmpdir(), "quiz-chaos-"));
const gameFile = join(dataDir, "game.json");
writeFileSync(gameFile, JSON.stringify(bigGame(QUESTIONS)));
const log = (s: string): void => {
  process.stdout.write(`${new Date().toISOString().slice(11, 23)}  ${s}\n`);
};

let server: ServerProcess = await spawnServer({ dataDir, port: PORT, env: { QUIZ_GAME: gameFile, QUIZ_NEW_SESSION: "1", QUIZ_SEATS: String(PLAYERS) } });
const tok = tokens(dataDir);
const t = (label: string): string => tok.get(label) ?? "";

const ctl = connect(PORT, t("Régie"), "c_chaos_ctl");
let out: QuizClient = connect(PORT, t("Sortie program"), "c_chaos_out");
await until(() => isOpen(ctl) && isOpen(out), 10_000, "control + output connected");

await drive(ctl, { type: "game.start" });
for (let i = 1; i <= PLAYERS; i++) {
  await drive(ctl, { type: "player.add", participantId: `p_${i}`, displayName: `Bot ${i}`, seat: i, channel: "seat" });
}
await drive(ctl, { type: "round.start" });
const clients = Array.from({ length: PLAYERS }, (_, i) => connect(PORT, t(`Siège ${i + 1}`), `c_chaos_seat${i + 1}`));
const bots = clients.map((c) => new Bot(c, { thinkMs: 1200 }));
await until(() => clients.every(isOpen), 15_000, "all seats connected");
log(`${PLAYERS} bots connectés`);

const step = (a: Action): Promise<void> => drive(ctl, a);

for (let q = 1; q <= QUESTIONS; q++) {
  await step({ type: "question.present" });
  if (q === 3) {
    await sleep(500);
    log("CHAOS: serveur tué (kill -9) en pleine question");
    await server.kill();
    await sleep(800);
    server = await spawnServer({ dataDir, port: PORT, env: { QUIZ_SEATS: String(PLAYERS) } });
    log("serveur relancé depuis le journal");
  }
  if (q === 5) {
    await sleep(400);
    log("CHAOS: coupure réseau de toutes les tablettes pendant les réponses");
    for (const c of clients) c.dropConnection();
  }
  if (q === 7) {
    await sleep(300);
    log("CHAOS: rechargement de la sortie program");
    out.stop();
    out = connect(PORT, t("Sortie program"), "c_chaos_out");
  }
  await sleep(2500);
  await step({ type: "question.lock" });
  await step({ type: "question.reveal" });
  await step({ type: "question.next" });
}

await until(() => bots.every((b) => b.queueLength === 0) && isOpen(out) && out.view?.phase === "game.end", 20_000, "queues drained, output at game end");
await sleep(300);
const outView = out.view;
for (const c of [...clients, ctl, out]) c.stop();
await server.kill();

// ── Offline verification from the journal only ───────────────────────────────
const store = new SqliteEventStore(join(dataDir, "journal.db"));
const sessionId = store.latestSessionId();
if (sessionId === null) throw new Error("no session");
const session = store.getSession(sessionId);
if (session === null) throw new Error("no session");
const events = store.events(sessionId);
store.close();

const game = replay(session, events, defaultRegistry);
const replayedOut = JSON.parse(JSON.stringify(project(game, { role: "output", scene: "program" }, defaultRegistry))) as unknown;
const journalKeys = events.filter((e) => e.action.type === "answer.submit").map((e) => e.idempotencyKey);
const ackedKeys = bots.flatMap((b) => b.acked.map((a) => a.key));
const journalSet = new Set(journalKeys);

const lost = ackedKeys.filter((k) => !journalSet.has(k));
const duplicates = journalKeys.length - journalSet.size;
const phantom = journalKeys.filter((k) => k !== null && !ackedKeys.includes(k));
// Deep equality (key order differs: the client re-validates views with Zod).
const sameFinalState = isDeepStrictEqual(replayedOut, outView);
const rejected = bots.reduce((n, b) => n + b.rejected.length, 0);

/** First differing JSON path, to explain a mismatch. */
function firstDiff(a: unknown, b: unknown, path = ""): string | null {
  if (isDeepStrictEqual(a, b)) return null;
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}/${k}`); // oxlint-disable-line typescript/no-unsafe-type-assertion -- diagnostic only
      if (d !== null) return d;
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 120)} ≠ ${JSON.stringify(b)?.slice(0, 120)}`;
}

log("──────── RÉSULTAT CHAOS ────────");
log(`événements au journal : ${events.length} ; réponses acquittées : ${ackedKeys.length} ; refusées (après verrouillage) : ${rejected}`);
log(`réponses perdues : ${lost.length} ; doublons : ${duplicates} ; réponses fantômes : ${phantom.length}`);
log(`état final de la sortie = rejeu du journal : ${sameFinalState ? "OUI" : "NON"}`);
if (!sameFinalState) log(`premier écart (rejeu ≠ sortie) : ${firstDiff(replayedOut, outView)}`);
const ok = lost.length === 0 && duplicates === 0 && phantom.length === 0 && sameFinalState && ackedKeys.length > PLAYERS * (QUESTIONS - 2);
log(ok ? "✓ CHAOS OK" : "✗ CHAOS ÉCHEC");
rmSync(dataDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
