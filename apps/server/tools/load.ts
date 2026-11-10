import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { SqliteEventStore } from "../src/store/sqlite-event-store.ts";
import { bigGame, connect, drive, isOpen, sleep, spawnServer, tokens, until } from "./harness.ts";

/**
 * pnpm load — phase 0 exit criterion (doc 05): 500 simulated tablets on a full game, 0 lost answer,
 * broadcast latency measured. k6 runs the real QuizClient (bundled); this script drives the game and audits the journal.
 */
const TABLETS = Number(process.env["LOAD_TABLETS"] ?? 500);
const QUESTIONS = Number(process.env["LOAD_QUESTIONS"] ?? 10);
const OPEN_MS = Number(process.env["LOAD_OPEN_MS"] ?? 6000);
const PORT = Number(process.env["LOAD_PORT"] ?? 7312);
const K6 = process.env["K6_BIN"] ?? (process.platform === "win32" ? "C:\\Program Files\\k6\\k6.exe" : "k6");

const dataDir = mkdtempSync(join(tmpdir(), "quiz-load-"));
const log = (s: string): void => {
  process.stdout.write(`${new Date().toISOString().slice(11, 23)}  ${s}\n`);
};

const gameFile = join(dataDir, "game.json");
writeFileSync(gameFile, JSON.stringify(bigGame(QUESTIONS, TABLETS + 10)));
const server = await spawnServer({ dataDir, port: PORT, env: { QUIZ_GAME: gameFile, QUIZ_NEW_SESSION: "1", QUIZ_SEATS: String(TABLETS), QUIZ_OUTPUTS: "program" } });
const tok = tokens(dataDir);
const ctl = connect(PORT, tok.get("Régie") ?? "", "c_load_ctl");
const out = connect(PORT, tok.get("Sortie program") ?? "", "c_load_out");
await until(() => isOpen(ctl) && isOpen(out), 10_000, "control connected");
await drive(ctl, { type: "game.start" });
for (let i = 1; i <= TABLETS; i++) await drive(ctl, { type: "player.add", participantId: `p_${i}`, displayName: `Tablette ${i}`, seat: i, channel: "seat" });
await drive(ctl, { type: "round.start" });
log(`${TABLETS} joueurs créés`);

// Bundle the k6 script with the real protocol client (k6 does not resolve node modules).
const bundle = join(dataDir, "load.bundle.js");
await build({ entryPoints: [join(import.meta.dirname, "k6", "load.k6.ts")], bundle: true, format: "esm", platform: "neutral", target: "es2020", external: ["k6", "k6/*"], outfile: bundle, logLevel: "error", mainFields: ["module", "main"] });
const tokensFile = join(dataDir, "tokens.json");
writeFileSync(tokensFile, JSON.stringify(Array.from({ length: TABLETS }, (_, i) => tok.get(`Siège ${i + 1}`) ?? "")));
const summaryFile = join(dataDir, "summary.json");
const k6 = spawn(K6, ["run", "--quiet", "--summary-export", summaryFile, "-e", `TOKENS=${tokensFile}`, "-e", `URL=ws://127.0.0.1:${PORT}/ws`, bundle], { stdio: ["ignore", "inherit", "inherit"] });
const k6Done = new Promise<number>((r) => k6.once("exit", (code) => r(code ?? 1)));

// Wait for every tablet to be connected before playing.
const health = async (): Promise<{ clients: number; lastSeq: number }> => (await (await fetch(`http://127.0.0.1:${PORT}/health?t=${tok.get("Régie") ?? ""}`)).json()) as { clients: number; lastSeq: number }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own endpoint
const t0 = Date.now();
while ((await health()).clients < TABLETS + 2) {
  if (Date.now() - t0 > 120_000) throw new Error("tablets did not connect");
  await sleep(250);
}
log(`${TABLETS} tablettes connectées en ${Date.now() - t0} ms`);

// Broadcast latency as seen by the output: time from control ack to the output view change.
const broadcast: number[] = [];
for (let q = 1; q <= QUESTIONS; q++) {
  for (const type of ["question.present", "question.open"] as const) {
    const before = out.view?.phase;
    const s = Date.now();
    await drive(ctl, { type });
    await until(() => out.view?.phase !== before, 5000, "output updated");
    broadcast.push(Date.now() - s);
  }
  await sleep(OPEN_MS);
  if (out.view?.phase !== "open") log(`DEBUG phase=${out.view?.phase} timer=${JSON.stringify(out.view?.timer)} now=${Date.now()}`);
  for (const type of ["question.lock", "question.reveal", "question.next"] as const) {
    try {
      await drive(ctl, { type });
    } catch (e) {
      const st = new SqliteEventStore(join(dataDir, "journal.db"));
      const evs = st.events(st.latestSessionId() ?? "");
      st.close();
      const tail = evs.filter((x) => x.action.type !== "answer.submit").slice(-6).map((x) => `${x.seq}:${x.action.type}:${x.actor.role}`);
      log(`DEBUG ctl=${ctl.view?.phase} out=${out.view?.phase} events=${evs.length} tail=${tail.join(" ")}`);
      throw e;
    }
  }
  log(`question ${q}/${QUESTIONS} jouée`);
}
const exit = await k6Done;
ctl.stop();
out.stop();
await server.kill();

const summary = JSON.parse(readFileSync(summaryFile, "utf8")) as { metrics: Record<string, Record<string, number> | undefined> }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- k6 summary export
const m = (name: string, field: string): number => summary.metrics[name]?.[field] ?? 0;
const store = new SqliteEventStore(join(dataDir, "journal.db"));
const sid = store.latestSessionId() ?? "";
const journalAnswers = store.events(sid).filter((e) => e.action.type === "answer.submit").length;
store.close();

const ackedCount = m("answers_acked", "count");
const lost = Math.max(0, ackedCount - journalAnswers);
const phantom = Math.max(0, journalAnswers - ackedCount);
const sorted = broadcast.toSorted((a, b) => a - b);
const pct = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

log("──────── RÉSULTAT CHARGE ────────");
log(`tablettes : ${TABLETS} ; questions : ${QUESTIONS} ; réponses acquittées (k6) : ${ackedCount} ; au journal : ${journalAnswers}`);
log(`réponses perdues : ${lost} ; fantômes : ${phantom} ; non acquittées en fin : ${m("answers_unacked", "count")} ; refusées : ${m("answers_rejected", "count")} ; reconnexions : ${m("reconnects", "count")}`);
log(`latence ack réponse (k6) : médiane ${m("ack_latency", "med").toFixed(1)} ms, p95 ${m("ack_latency", "p(95)").toFixed(1)} ms, max ${m("ack_latency", "max").toFixed(1)} ms`);
log(`latence de diffusion régie → sortie : médiane ${pct(50)} ms, p95 ${pct(95)} ms, max ${pct(100)} ms`);
log(`connexion (welcome) : p95 ${m("welcome_latency", "p(95)").toFixed(0)} ms`);
log(`reconnexions : coupures 1006=${m("closed_1006", "count")} · refus serveur 4000=${m("closed_4000", "count")} · connexions initiales refusées puis réessayées=${m("closed_other", "count")} (dans les ${m("close_at_ms", "max")} premières ms)`);
const ok = exit === 0 && lost === 0 && phantom === 0 && m("answers_unacked", "count") === 0 && ackedCount >= TABLETS * QUESTIONS * 0.95;
log(ok ? "✓ CHARGE OK" : `✗ CHARGE ÉCHEC (k6 exit ${exit})`);
rmSync(dataDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
