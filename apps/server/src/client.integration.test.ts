import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QuizClient, memoryIntentStore, type SocketLike } from "@quiz/protocol";
import type { View } from "@quiz/schema";
import { Config } from "./config.ts";
import { startServer, type RunningServer } from "./server.ts";

/** protocol/client against the real server: reconnection, queue, resync (doc 04, chaos:wifi-drop). */

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(dir?: string, port = 0): Promise<RunningServer> {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), "quiz-cli-"));
  if (dir === undefined) dirs.push(dataDir);
  const s = await startServer({ ...Config.parse({ dataDir, host: "127.0.0.1", logLevel: "fatal", seats: 2 }), port });
  servers.push(s);
  return s;
}

const tokenOf = (s: RunningServer, label: string): string => s.links.entries.find((e) => e.label === label)?.path.split("t=")[1] ?? "";
// Node 26's global WebSocket (undici) has the browser API the client expects — no adapter needed.
const nodeSocket = (url: string): SocketLike => new WebSocket(url);

function client(s: RunningServer, label: string, port = s.port): QuizClient {
  const c = new QuizClient({ url: `ws://127.0.0.1:${port}/ws`, token: tokenOf(s, label), clientId: `c_${label.length}x`, socket: nodeSocket, store: memoryIntentStore() });
  c.start();
  return c;
}

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const phase = (c: QuizClient): View["phase"] | undefined => c.view?.phase;

describe("QuizClient ⇄ server", () => {
  it("drives a game and keeps every client view equal to the server projection", async () => {
    const s = await boot();
    const ctl = client(s, "Régie");
    const out = client(s, "Sortie program");
    await until(() => ctl.state === "open" && out.state === "open");
    for (const a of [{ type: "game.start" }, { type: "player.add", participantId: "p_1", displayName: "Ana", seat: 1, channel: "seat" }, { type: "round.start" }, { type: "question.present" }] as const) {
      expect(await ctl.submit(a)).toMatchObject({ ok: true });
    }
    await until(() => phase(out) === "open");
    expect(out.view).toEqual(JSON.parse(JSON.stringify(s.runtime.view({ role: "output", scene: "program" }))));
    ctl.stop();
    out.stop();
  });

  it("chaos:wifi-drop — an answer sent during a drop is applied exactly once", async () => {
    const s = await boot();
    const ctl = client(s, "Régie");
    await until(() => ctl.state === "open");
    for (const a of [{ type: "game.start" }, { type: "player.add", participantId: "p_1", displayName: "Ana", seat: 1, channel: "seat" }, { type: "round.start" }, { type: "question.present" }] as const) await ctl.submit(a);
    const seat = client(s, "Siège 1");
    await until(() => seat.state === "open");
    seat.dropConnection(); // Wi-Fi gone
    const ack = seat.submit({ type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["b"] } });
    await expect(ack).resolves.toMatchObject({ ok: true }); // resent after reconnect
    expect(seat.queued).toHaveLength(0);
    const answers = s.store.events(s.runtime.session.id).filter((e) => e.action.type === "answer.submit");
    expect(answers).toHaveLength(1);
    // The ack is sent at commit; the view follows within the 25 ms broadcast coalescing window.
    await until(() => seat.view?.role === "player" && seat.view.myAnswer?.[0] === "b");
    ctl.stop();
    seat.stop();
  });

  it("chaos:kill-server — clients reconnect to the restarted server and resync to the same state", async () => {
    const s1 = await boot();
    const dataDir = dirs.at(-1) ?? "";
    const port = s1.port;
    const ctl = client(s1, "Régie");
    const out = client(s1, "Sortie program");
    await until(() => ctl.state === "open" && out.state === "open");
    await ctl.submit({ type: "game.start" });
    await ctl.submit({ type: "round.start" });
    await s1.close(); // crash-like stop (journal already durable)
    servers.splice(0);
    await until(() => out.state === "reconnecting");
    const pendingWhileDown = ctl.submit({ type: "question.present" });
    const s2 = await boot(dataDir, port);
    await expect(pendingWhileDown).resolves.toMatchObject({ ok: true });
    await until(() => phase(out) === "open");
    expect(out.view).toEqual(JSON.parse(JSON.stringify(s2.runtime.view({ role: "output", scene: "program" }))));
    ctl.stop();
    out.stop();
  });
});

describe("clock (NTP-style round trip)", () => {
  it("answers the pong of the last ping with its measured round trip; a stale or forged pong gets nothing", async () => {
    const s = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    const got: { t: string; serverTime?: number; rttMs?: number }[] = [];
    ws.addEventListener("message", (ev) => { if (typeof ev.data === "string") got.push(JSON.parse(ev.data) as { t: string }); }); // oxlint-disable-line typescript/no-unsafe-type-assertion -- test reads raw frames
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", v: 1, token: tokenOf(s, "Sortie program"), clientId: "c_clock" }));
    await until(() => got.some((m) => m.t === "ping"), 5000);
    const ping = got.find((m) => m.t === "ping");
    ws.send(JSON.stringify({ t: "pong", clientTime: 0, serverTime: (ping?.serverTime ?? 0) + 1 })); // forged
    ws.send(JSON.stringify({ t: "pong", clientTime: 0, serverTime: ping?.serverTime ?? 0 }));
    await until(() => got.some((m) => m.t === "clock"));
    const clocks = got.filter((m) => m.t === "clock");
    expect(clocks).toHaveLength(1);
    expect(clocks[0]?.serverTime).toBe(ping?.serverTime);
    expect(clocks[0]?.rttMs).toBeGreaterThanOrEqual(0);
    ws.close();
  }, 10_000);
});

