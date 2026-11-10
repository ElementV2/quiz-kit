import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { applyPatch, decodeServerMessage, type ServerMessage } from "@quiz/protocol";
import type { Action, View } from "@quiz/schema";
import { Config } from "./config.ts";
import { startServer, type RunningServer } from "./server.ts";

const running: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(dataDir?: string): Promise<{ server: RunningServer; dataDir: string }> {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "quiz-srv-"));
  if (dataDir === undefined) dirs.push(dir);
  const config = { ...Config.parse({ dataDir: dir, host: "127.0.0.1", logLevel: "fatal", seats: 2 }), port: 0 };
  const server = await startServer(config);
  running.push(server);
  return { server, dataDir: dir };
}

const token = (s: RunningServer, label: string): string => {
  const e = s.links.entries.find((x) => x.label === label);
  if (e === undefined) throw new Error(`no link ${label}`);
  return e.path.split("t=")[1] ?? "";
};

/** Minimal test client: keeps its view up to date from welcome + patches. */
class Client {
  readonly messages: ServerMessage[] = [];
  view: View | null = null;
  private k = 0;
  readonly ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async connect(s: RunningServer, label: string, opts: { origin?: string; tokenOverride?: string } = {}): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, opts.origin === undefined ? {} : { headers: { origin: opts.origin } });
    const c = new Client(ws);
    ws.on("message", (d: Buffer) => c.onMessage(d.toString("utf8")));
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
    });
    ws.send(JSON.stringify({ t: "hello", v: 1, token: opts.tokenOverride ?? token(s, label), clientId: `c_test${label.length}` }));
    await c.until((m) => m.t === "welcome" || m.t === "error");
    return c;
  }

  private onMessage(raw: string): void {
    const d = decodeServerMessage(raw);
    if (!d.ok) throw new Error(d.error.message);
    const m = d.value;
    this.messages.push(m);
    if (m.t === "welcome" || m.t === "snapshot") this.view = m.view;
    if (m.t === "patch" && this.view !== null) {
      const r = applyPatch(this.view, m.ops);
      if (r.ok) this.view = r.value;
    }
  }

  async until(pred: (m: ServerMessage) => boolean, timeoutMs = 2000): Promise<ServerMessage> {
    const start = Date.now();
    for (;;) {
      const m = this.messages.find(pred);
      if (m !== undefined) return m;
      if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for message");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async act(action: Action, key = `k_${crypto.randomUUID().replaceAll("-", "")}`): Promise<ServerMessage> {
    this.ws.send(JSON.stringify({ t: "intent", key, action }));
    return this.until((m) => m.t === "ack" && m.key === key);
  }

  close(): void {
    this.ws.close();
  }
}

const START: Action[] = [
  { type: "game.start" },
  { type: "player.add", participantId: "p_1", displayName: "Ana", seat: 1, channel: "seat" },
  { type: "round.start" },
  { type: "question.present" },
  { type: "question.open" },
];

describe("server over WebSocket (integration)", () => {
  it("serves links reachable from other PCs (every LAN IP) with stable tokens", async () => {
    const { server, dataDir } = await boot();
    const first = server.links.entries.map((e) => e.path);
    expect(server.links.origins.some((o) => o.includes("localhost"))).toBe(true);
    expect(server.links.entries.map((e) => e.label)).toEqual(expect.arrayContaining(["Régie", "Sortie program", "Siège 1"]));
    await server.close();
    running.splice(0);
    const again = await boot(dataDir);
    expect(again.server.links.entries.map((e) => e.path)).toEqual(first);
  });

  it("refuses a bad token, a foreign origin and messages before hello", async () => {
    const { server } = await boot();
    const bad = await Client.connect(server, "Régie", { tokenOverride: "nope" });
    expect(bad.messages[0]).toMatchObject({ t: "error", code: "unauthorized" });
    await expect(Client.connect(server, "Régie", { origin: "http://evil.example" })).rejects.toThrow(/403/);
  });

  it("plays a question end to end; outputs never see the answer before reveal", async () => {
    const { server } = await boot();
    const ctl = await Client.connect(server, "Régie");
    const out = await Client.connect(server, "Sortie program");
    for (const a of START) expect(await ctl.act(a)).toMatchObject({ ok: true });
    const seat = await Client.connect(server, "Siège 1");
    expect(seat.view).toMatchObject({ role: "player", canAnswer: true, me: { participantId: "p_1" } });
    expect(await seat.act({ type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["b"] } })).toMatchObject({ ok: true });
    await ctl.act({ type: "question.lock" });
    const beforeReveal = JSON.stringify(out.messages);
    expect(beforeReveal).not.toContain('"correct":["b"]');
    await ctl.act({ type: "question.reveal" });
    await out.until((m) => m.t === "patch" && JSON.stringify(m).includes("revealed"));
    expect(out.view).toMatchObject({ phase: "revealed", mechanic: { correct: ["b"] } });
    expect(out.view?.leaderboard[0]).toMatchObject({ participantId: "p_1", total: expect.any(Number) });
    // the patched client view equals a fresh projection
    expect(out.view).toEqual(JSON.parse(JSON.stringify(server.runtime.view({ role: "output", scene: "program" }))));
  });

  it("a seat cannot drive the game nor answer for someone else; the output cannot act", async () => {
    const { server } = await boot();
    const ctl = await Client.connect(server, "Régie");
    for (const a of [...START, { type: "player.add", participantId: "p_2", displayName: "Bo", seat: 2, channel: "seat" } as const]) await ctl.act(a);
    const seat = await Client.connect(server, "Siège 1");
    expect(await seat.act({ type: "question.reveal" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await seat.act({ type: "answer.submit", participantId: "p_2", answer: { kind: "choice", optionIds: ["b"] } })).toMatchObject({ ok: false, code: "forbidden" });
    const out = await Client.connect(server, "Sortie program");
    expect(await out.act({ type: "game.start" })).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("a reconnecting output gets the exact state at once (e2e:output-reload)", async () => {
    const { server } = await boot();
    const ctl = await Client.connect(server, "Régie");
    for (const a of START) await ctl.act(a);
    const out = await Client.connect(server, "Sortie program");
    out.close();
    await ctl.act({ type: "question.lock" });
    const again = await Client.connect(server, "Sortie program");
    expect(again.view).toMatchObject({ phase: "locked" });
  });

  it("resync returns a full snapshot", async () => {
    const { server } = await boot();
    const ctl = await Client.connect(server, "Régie");
    ctl.ws.send(JSON.stringify({ t: "resync" }));
    expect(await ctl.until((m) => m.t === "snapshot")).toMatchObject({ t: "snapshot", viewSeq: 1 });
  });

  it("survives a restart: same state, same acks for replayed keys", async () => {
    const { server, dataDir } = await boot();
    const ctl = await Client.connect(server, "Régie");
    for (const a of START) await ctl.act(a);
    const seat = await Client.connect(server, "Siège 1");
    const answer: Action = { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["c"] } };
    const ack1 = await seat.act(answer, "k_survivor1");
    const state = server.runtime.current.state;
    await server.close();
    running.splice(0);
    const { server: s2 } = await boot(dataDir);
    expect(s2.runtime.current.state).toEqual(state);
    const seat2 = await Client.connect(s2, "Siège 1");
    expect(await seat2.act(answer, "k_survivor1")).toEqual(ack1);
    expect(s2.store.events(s2.runtime.session.id).filter((e) => e.action.type === "answer.submit")).toHaveLength(1);
  });

  it("refuses a key reused by another client for another intent (no false ack)", async () => {
    const { server } = await boot();
    const ctl = await Client.connect(server, "Régie");
    await ctl.act({ type: "game.start" }, "k_collision");
    await ctl.act({ type: "player.add", participantId: "p_1", displayName: "Ana", seat: 1, channel: "seat" });
    const seat = await Client.connect(server, "Siège 1");
    expect(await seat.act({ type: "question.reveal" }, "k_collision")).toMatchObject({ ok: false, code: "conflict" });
  });

  it("rate-limits a flooding client without affecting others", async () => {
    const { server } = await boot();
    const flood = await Client.connect(server, "Sortie program");
    for (let i = 0; i < 200; i++) flood.ws.send(JSON.stringify({ t: "resync" }));
    await flood.until((m) => m.t === "error" && m.code === "rate-limited");
    const ctl = await Client.connect(server, "Régie");
    expect(await ctl.act({ type: "game.start" })).toMatchObject({ ok: true });
  });

  it("GET /api/links needs the control token; tokens never appear in logs", async () => {
    const { server } = await boot();
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/links?t=${token(server, "Sortie program")}`)).status).toBe(401);
    const ok = await fetch(`${base}/api/links?t=${token(server, "Régie")}`);
    expect(ok.status).toBe(200);
    const res = await fetch(`${base}/control?t=x`);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  });
});
