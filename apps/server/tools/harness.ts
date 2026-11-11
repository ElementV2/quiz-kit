import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QuizClient, memoryIntentStore, type ClientStatus } from "@quiz/protocol";
import type { Action, GameDocument, Question } from "@quiz/schema";

/** Shared helpers for chaos / load tools (real processes, real sockets). */

export const SERVER_DIR = join(import.meta.dirname, "..");
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until(pred: () => boolean, ms = 10_000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(20);
  }
}

/** A game with `n` single-choice questions, answers 4 options, 100 pts with decay (load / chaos). */
export function bigGame(n: number, maxPlayers = 1000): GameDocument {
  const questions: Question[] = Array.from({ length: n }, (_, i) => ({
    id: `q_${i + 1}`,
    prompt: { text: `Question ${i + 1}` },
    answerSpec: { kind: "single", correct: "b", options: ["a", "b", "c", "d"].map((id) => ({ id, label: id.toUpperCase() })) },
    hints: [],
    tags: [],
  }));
  return {
    schemaVersion: 1,
    scenes: [],
    title: "Charge",
    questions,
    format: {
      id: "f_load",
      name: "Charge",
      participants: { max: maxPlayers },
      tieBreak: "control",
      rounds: [{ id: "r_1", title: "Manche", mechanic: "choice", mechanicConfig: {}, questions: questions.map((q) => q.id), reserve: [], timer: { durationMs: 60_000, autoLock: true }, scoring: [{ type: "base", points: 100 }, { type: "timeDecay", minPoints: 50 }] }],
    },
  };
}

export type ServerProcess = { readonly child: ChildProcess; readonly port: number; readonly dataDir: string; kill(): Promise<void> };

/** Starts `node src/main.ts` as a real child process and waits for /health. */
export async function spawnServer(opts: { dataDir: string; port: number; env?: Record<string, string> }): Promise<ServerProcess> {
  const child = spawn(process.execPath, ["src/main.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, QUIZ_DATA_DIR: opts.dataDir, QUIZ_PORT: String(opts.port), QUIZ_HOST: "127.0.0.1", QUIZ_LOG_LEVEL: "error", ...opts.env },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${opts.port}/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode})`);
    if (Date.now() - t0 > 15_000) throw new Error("server did not start");
    await sleep(50);
  }
  return {
    child,
    port: opts.port,
    dataDir: opts.dataDir,
    kill: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGKILL"); // hard kill: no graceful shutdown, like a power cut of the process
      await exited;
    },
  };
}

/** Role tokens from the links file written by the server. */
export function tokens(dataDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(join(dataDir, "links.txt"), "utf8").split("\n")) {
    const [label, url] = line.split("\t");
    if (label === undefined || url === undefined || map.has(label)) continue;
    map.set(label, url.split("t=")[1] ?? "");
  }
  return map;
}

export function connect(port: number, token: string, clientId: string): QuizClient {
  const c = new QuizClient({ url: `ws://127.0.0.1:${port}/ws`, token, clientId, socket: (u) => new WebSocket(u), store: memoryIntentStore() });
  c.start();
  return c;
}

/** Control helper: submits and throws on rejection (the script drives a valid game). */
export async function drive(ctl: QuizClient, action: Action): Promise<void> {
  const ack = await ctl.submit(action);
  if (!ack.ok) throw new Error(`${action.type} refusé : ${ack.reason}`);
}

export const isOpen = (c: QuizClient): boolean => (c.state satisfies ClientStatus) === "open";
