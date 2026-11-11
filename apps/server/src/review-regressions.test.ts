import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRegistry, defaultRegistry, defineMechanic, choice, type Mechanic, type ChoiceConfig, type ChoiceState } from "@quiz/engine";
import { DEMO_GAME, RETIRED_TEMPLATES, type Action, type Session } from "@quiz/schema";
import { Config } from "./config.ts";
import { buildHttpApp, loggerOptions } from "./http/app.ts";
import { SessionRuntime } from "./runtime/session-runtime.ts";
import { Rehearsal } from "./rehearsal.ts";
import { ChatHub } from "./chat/chat-hub.ts";
import { MediaStore } from "./media/media-store.ts";
import { GameLibrary } from "./media/library.ts";
import { startServer, type RunningServer } from "./server.ts";
import { MemoryEventStore } from "./store/event-store.ts";
import { FakeTime, RecordingLog, silentLog } from "./testing/fakes.ts";

/** One test per finding of the first server review. */

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function boot(): Promise<RunningServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "quiz-rev-"));
  dirs.push(dataDir);
  const s = await startServer({ ...Config.parse({ dataDir, host: "127.0.0.1", logLevel: "fatal", seats: 2 }), port: 0 });
  servers.push(s);
  return s;
}
const tokenOf = (s: RunningServer, id: string): string => s.links.entries.find((e) => e.id === id)?.path.split("t=")[1] ?? "";

function rawSocket(s: RunningServer): Promise<{ ws: WebSocket; messages: Record<string, unknown>[]; closed: Promise<number> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (d: Buffer) => messages.push(JSON.parse(d.toString()) as Record<string, unknown>)); // oxlint-disable-line typescript/no-unsafe-type-assertion -- test-only inspection
  const closed = new Promise<number>((r) => ws.once("close", (code: number) => r(code)));
  return new Promise((res) => ws.once("open", () => res({ ws, messages, closed })));
}
const hello = (ws: WebSocket, token: string): void => ws.send(JSON.stringify({ t: "hello", v: 1, token, clientId: "c_rev" }));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const session: Session = { schemaVersion: 1, id: "ses_rev", game: DEMO_GAME, seed: 1, createdAt: 0 };
const CTL = { role: "control", id: "c_op" } as const;
const OPEN: Action[] = [
  { type: "game.start" },
  { type: "player.add", participantId: "p_1", displayName: "Ana", seat: 1, channel: "seat" },
  { type: "round.start" },
  { type: "question.present" },
  { type: "question.open" },
];

describe("review #1 — nothing after the commit can break the loop", () => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only: recover the typed mechanic
  const typed = choice as unknown as Mechanic<ChoiceConfig, ChoiceState>;
  const throwing = defineMechanic<ChoiceConfig, ChoiceState>({ ...typed, project: () => { throw new Error("projection bug"); } });

  it("a throwing projection is logged, the action stays committed, other viewers still get updates", () => {
    const store = new MemoryEventStore();
    store.createSession(session);
    const log = new RecordingLog();
    const rt = new SessionRuntime(store, createRegistry([throwing]), session, new FakeTime().clock, new FakeTime(), log);
    let outputs = 0;
    rt.subscribe({ viewer: { role: "output", scene: "x" }, update: () => outputs++ });
    for (const a of OPEN.slice(0, 3)) expect(rt.submit(a, CTL, null)).toMatchObject({ ok: true });
    expect(() => rt.submit({ type: "question.present" }, CTL, null)).not.toThrow();
    expect(store.events(session.id)).toHaveLength(4);
    expect(log.lines.some((l) => l.level === "error")).toBe(true);
    expect(outputs).toBe(3);
  });

  it("a timer expiry refused by a failing journal is retried until it passes", () => {
    const store = new MemoryEventStore();
    store.createSession(session);
    const time = new FakeTime();
    const rt = new SessionRuntime(store, createRegistry([choice]), session, time.clock, time, silentLog);
    for (const a of OPEN) rt.submit(a, CTL, null);
    store.failNextAppend = true;
    time.advance(20_000);
    expect(rt.current.state.phase).toBe("open");
    expect(rt.journalHealth.ok).toBe(false);
    time.advance(1000);
    expect(rt.current.state.phase).toBe("locked");
    expect(rt.journalHealth.ok).toBe(true);
  });
});

describe("review #2 — tokens never reach the logs", () => {
  it("404s and errors log redacted URLs only", async () => {
    let out = "";
    const deps = {
      runtime: () => { throw new Error("unused"); },
      links: () => ({ origins: [], secureOrigins: [], entries: [] }),
      revoke: () => ({ origins: [], secureOrigins: [], entries: [] }),
      joinCode: () => "123456",
      newSession: () => ({ id: "ses_x" }),
      liveGameId: () => null,
      setLiveGameId: () => undefined,
      media: new MediaStore(mkdtempSync(join(tmpdir(), "quiz-media-"))),
      library: new GameLibrary(mkdtempSync(join(tmpdir(), "quiz-lib-"))),
      join: () => ({ ok: false as const, error: "unused" }),
      claimSeat: () => ({ ok: false as const, error: "unused" }),
      secret: "s",
      show: "main",
      isRevoked: () => false,
      clock: () => 0,
      connections: () => 0,
      presence: () => ({}),
      health: () => ({}),
      dataDir: "",
      rehearsal: new Rehearsal({ set: () => () => undefined }),
      registry: defaultRegistry,
      staffCode: () => "ABCD2345",
      rotateStaffCode: () => "ABCD2345",
      vmix: { status: () => ({}), config: () => null, set: () => undefined },
      standby: { status: () => null, promote: () => "pas un secours" as string | null },
      chat: new ChatHub({ runtime: () => { throw new Error("unused"); }, timers: { set: () => () => undefined }, clock: () => 0, dataDir: "", log: { info: () => undefined, warn: () => undefined } }),
    };
    const app = buildHttpApp(deps, { logger: loggerOptions("info", { write: (s: string) => (out += s) }) });
    await app.inject({ method: "GET", url: "/control/?t=SECRETTOKEN1" });
    await app.inject({ method: "GET", url: "/nope?x=1&t=SECRETTOKEN2" });
    await app.inject({ method: "POST", url: "/api/revoke?t=SECRETTOKEN3", payload: "{bad json", headers: { "content-type": "application/json" } });
    await app.close();
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/SECRETTOKEN/);
  });
});

describe("media are served with their own type and cache header (SVG logo, studio graphics)", () => {
  it("an extension-less stored SVG keeps image/svg+xml and the long cache", async () => {
    const { Readable } = await import("node:stream");
    const media = new MediaStore(mkdtempSync(join(tmpdir(), "quiz-media-")));
    const m = await media.put(Readable.from([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')]), "image/svg+xml", "logo.svg");
    const deps = {
      runtime: () => { throw new Error("unused"); },
      links: () => ({ origins: [], secureOrigins: [], entries: [] }),
      revoke: () => ({ origins: [], secureOrigins: [], entries: [] }),
      joinCode: () => "123456",
      newSession: () => ({ id: "ses_x" }),
      liveGameId: () => null,
      setLiveGameId: () => undefined,
      media,
      library: new GameLibrary(mkdtempSync(join(tmpdir(), "quiz-lib-"))),
      join: () => ({ ok: false as const, error: "unused" }),
      claimSeat: () => ({ ok: false as const, error: "unused" }),
      secret: "s",
      show: "main",
      isRevoked: () => false,
      clock: () => 0,
      connections: () => 0,
      presence: () => ({}),
      health: () => ({}),
      dataDir: "",
      rehearsal: new Rehearsal({ set: () => () => undefined }),
      registry: defaultRegistry,
      staffCode: () => "ABCD2345",
      rotateStaffCode: () => "ABCD2345",
      vmix: { status: () => ({}), config: () => null, set: () => undefined },
      standby: { status: () => null, promote: () => "pas un secours" },
      chat: new ChatHub({ runtime: () => { throw new Error("unused"); }, timers: { set: () => () => undefined }, clock: () => 0, dataDir: "", log: { info: () => undefined, warn: () => undefined } }),
    };
    const app = buildHttpApp(deps, { logger: false });
    const res = await app.inject({ method: "GET", url: `/media/${m.hash}` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000");
    // The route's sandbox CSP survives the global security-headers hook (review B1).
    expect(res.headers["content-security-policy"]).toMatch(/sandbox/);
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-disposition"]).toBe("attachment");
  });
});

describe("review #4 — revocation works and takes effect immediately", () => {
  it("revoking a seat cuts its open connection, refuses the old link and issues a new one", async () => {
    const s = await boot();
    const old = tokenOf(s, "seat-1");
    const { ws, closed } = await rawSocket(s);
    hello(ws, old);
    await wait(100);
    const res = await fetch(`http://127.0.0.1:${s.port}/api/revoke?t=${tokenOf(s, "control")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: "seat-1" }) });
    expect(res.status).toBe(200);
    expect(await closed).toBe(1006); // terminated at once (second review #5)
    const fresh = tokenOf(s, "seat-1");
    expect(fresh).not.toBe(old);
    const again = await rawSocket(s);
    hello(again.ws, old);
    await wait(100);
    expect(again.messages[0]).toMatchObject({ t: "error", code: "unauthorized" });
    const ok = await rawSocket(s);
    hello(ok.ws, fresh);
    await wait(100);
    expect(ok.messages[0]).toMatchObject({ t: "welcome" });
    ok.ws.close();
  });

  it("the token secret is not stored in the journal", async () => {
    const s = await boot();
    expect(s.store.getMeta("token-secret")).toBeNull();
  });
});

describe("review #6 — idempotency survives a seat reassignment", () => {
  it("a resent answer after the seat changed hands gets its original ack, not a conflict", () => {
    const store = new MemoryEventStore();
    store.createSession(session);
    const rt = new SessionRuntime(store, createRegistry([choice]), session, new FakeTime().clock, new FakeTime(), silentLog);
    for (const a of OPEN) rt.submit(a, CTL, null);
    const answer: Action = { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["b"] } };
    const first = rt.submit(answer, { role: "seat", id: "p_1" }, "k_seatans1");
    rt.submit({ type: "player.add", participantId: "p_2", displayName: "Bo", channel: "seat" }, CTL, null);
    rt.submit({ type: "player.setSeat", participantId: "p_1", seat: null }, CTL, null);
    rt.submit({ type: "player.setSeat", participantId: "p_2", seat: 1 }, CTL, null);
    expect(rt.submit(answer, { role: "seat", id: "p_2" }, "k_seatans1")).toEqual(first);
  });

  it("an undo replayed with a different explicit target under the same key is refused", () => {
    const store = new MemoryEventStore();
    store.createSession(session);
    const rt = new SessionRuntime(store, createRegistry([choice]), session, new FakeTime().clock, new FakeTime(), silentLog);
    rt.submit({ type: "game.start" }, CTL, null);
    rt.submit({ type: "round.start" }, CTL, null);
    rt.submit({ type: "undo", targetSeq: 2 }, CTL, "k_undo0001");
    expect(rt.submit({ type: "undo", targetSeq: 1 }, CTL, "k_undo0001")).toMatchObject({ ok: false, code: "conflict" });
    expect(rt.submit({ type: "undo", targetSeq: 2 }, CTL, "k_undo0001")).toMatchObject({ ok: true });
  });
});

describe("review #11/#14 — transport edge cases", () => {
  it("public /health reveals nothing; details need the control token", async () => {
    const s = await boot();
    expect(await (await fetch(`http://127.0.0.1:${s.port}/health`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`http://127.0.0.1:${s.port}/health?t=${tokenOf(s, "control")}`)).json()).toMatchObject({ ok: true, journal: { journalMode: "wal", synchronous: 2, ok: true } });
  });

  it("closes a connection that never says hello", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "quiz-rev-"));
    dirs.push(dataDir);
    const s = await startServer({ ...Config.parse({ dataDir, host: "127.0.0.1", logLevel: "fatal" }), port: 0 });
    servers.push(s);
    const { closed, messages } = await rawSocket(s);
    expect(await closed).toBe(4000);
    expect(messages[0]).toMatchObject({ t: "error", code: "unauthorized" });
  }, 10_000);

  it("refuses binary frames and oversize messages", async () => {
    const s = await boot();
    const bin = await rawSocket(s);
    hello(bin.ws, tokenOf(s, "control"));
    await wait(50);
    bin.ws.send(Buffer.from([1, 2, 3]));
    expect(await bin.closed).toBe(4000);
    const big = await rawSocket(s);
    big.ws.send("x".repeat(20 * 1024));
    expect(await big.closed).toBe(1009); // ws maxPayload: "message too big"
  });

  it("a seat view never contains the correct answer before reveal", async () => {
    const s = await boot();
    for (const a of OPEN) s.runtime.submit(a, CTL, null);
    const seat = await rawSocket(s);
    hello(seat.ws, tokenOf(s, "seat-1"));
    await wait(100);
    const json = JSON.stringify(seat.messages);
    expect(json).toContain('"canAnswer":true');
    expect(json).not.toContain('"correct":["');
    expect(json).not.toContain("Hugues Capet");
    seat.ws.close();
  });
});

describe("second review", () => {
  const openRt = (store: MemoryEventStore, opts: { broadcastIntervalMs?: number; monotonic?: () => number; time?: FakeTime } = {}) => {
    const time = opts.time ?? new FakeTime();
    const rt = new SessionRuntime(store, createRegistry([choice]), session, time.clock, time, silentLog, {
      ...(opts.broadcastIntervalMs === undefined ? {} : { broadcastIntervalMs: opts.broadcastIntervalMs }),
      ...(opts.monotonic === undefined ? {} : { monotonic: opts.monotonic }),
      defer: (fn) => deferred.push(fn),
    });
    return { rt, time };
  };
  const deferred: (() => void)[] = [];
  const flush = () => deferred.splice(0).forEach((f) => f());

  it("#1 a wall-clock step back never freezes broadcasts (coalescing is monotonic)", () => {
    const store = new MemoryEventStore();
    store.createSession(session);
    let mono = 1000;
    const time = new FakeTime();
    const { rt } = openRt(store, { broadcastIntervalMs: 25, monotonic: () => mono, time });
    let updates = 0;
    rt.subscribe({ viewer: { role: "control" }, update: () => updates++ });
    rt.submit({ type: "game.start" }, CTL, null);
    expect(updates).toBe(1);
    time.now -= 30_000; // Windows time sync jumps back
    mono += 5;
    rt.submit({ type: "round.start" }, CTL, null);
    mono += 25;
    time.advance(25);
    expect(updates).toBe(2);
  });

  it("#3 a failed batch does not cache rejections computed on a state that never existed", () => {
    const store = new MemoryEventStore();
    store.createSession(session);
    const { rt } = openRt(store);
    for (const a of OPEN) rt.submit(a, CTL, null);
    const answer: Action = { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["b"] } };
    const acks: { ok: boolean; code?: string }[] = [];
    store.failNextAppend = true;
    rt.enqueue({ type: "question.lock" }, CTL, "k_lock0001", (a) => acks.push(a));
    rt.enqueue(answer, { role: "seat", id: "p_1" }, "k_late0001", (a) => acks.push(a)); // rejected: "locked" (provisional)
    flush();
    expect(acks.map((a) => a.ok)).toEqual([false, false]);
    expect(rt.current.state.phase).toBe("open");
    // The retry must be decided on the real state (still open) → accepted.
    expect(rt.submit(answer, { role: "seat", id: "p_1" }, "k_late0001")).toMatchObject({ ok: true });
  });

  it("#4 a failed batch keeps the true ack of a key committed earlier", () => {
    const store = new MemoryEventStore();
    store.createSession(session);
    const { rt } = openRt(store);
    const first = rt.submit({ type: "game.start" }, CTL, "k_done0001");
    const acks: unknown[] = [];
    store.failNextAppend = true;
    rt.enqueue({ type: "game.start" }, CTL, "k_done0001", (a) => acks.push(a)); // replay
    rt.enqueue({ type: "round.start" }, CTL, "k_new00001", (a) => acks.push(a)); // fresh → fails
    flush();
    expect(acks[0]).toEqual(first);
    expect(acks[1]).toMatchObject({ ok: false, code: "server-error" });
  });

  it("#5 a revoked connection is cut at once and can no longer act", async () => {
    const s = await boot();
    for (const a of OPEN) s.runtime.submit(a, CTL, null);
    const seat = await rawSocket(s);
    hello(seat.ws, tokenOf(s, "seat-1"));
    await wait(100);
    const before = s.store.events(s.runtime.session.id).length;
    s.revoke("seat-1");
    seat.ws.send(JSON.stringify({ t: "intent", key: "k_afterrev", action: { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["b"] } } }));
    await seat.closed;
    await wait(50);
    expect(s.store.events(s.runtime.session.id)).toHaveLength(before);
    expect(s.runtime.clientCount).toBe(0);
  });

  it("#2 refuses to start with an empty or truncated secret.key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "quiz-rev-"));
    dirs.push(dataDir);
    writeFileSync(join(dataDir, "secret.key"), "");
    await expect(startServer({ ...Config.parse({ dataDir, host: "127.0.0.1", logLevel: "fatal" }), port: 0 })).rejects.toThrow(/secret\.key invalide/);
  });

  it("#7 two players reusing one key for the same action do not share an ack", () => {
    const store = new MemoryEventStore();
    store.createSession(session);
    const { rt } = openRt(store);
    for (const a of OPEN) rt.submit(a, CTL, null);
    rt.submit({ type: "player.add", participantId: "p_2", displayName: "Bo", channel: "play" }, CTL, null);
    const a1: Action = { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["b"] } };
    rt.submit(a1, { role: "player", id: "p_1" }, "k_shared01");
    expect(rt.submit(a1, { role: "player", id: "p_2" }, "k_shared01")).toMatchObject({ ok: false, code: "conflict" });
  });

  it("#9 revocation bumps the generation atomically", async () => {
    const s = await boot();
    const before = tokenOf(s, "host");
    s.revoke("host");
    expect(s.store.getMeta("token-gen:host")).toBe("1");
    expect(s.store.isRevoked("host")).toBe(true);
    expect(tokenOf(s, "host")).not.toBe(before);
  });
});

describe("review #8 — « Envoyer au direct » and names", () => {
  it("apply-live: only the live game, base version required, stale copy refused, then applied and saved", async () => {
    const s = await boot();
    const t = tokenOf(s, "control");
    const base = `http://127.0.0.1:${s.port}`;
    const post = (path: string, body?: unknown) => fetch(`${base}${path}?t=${t}`, body === undefined ? { method: "POST" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await fetch(`${base}/api/games/g_rev?t=${t}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ game: DEMO_GAME }) });
    expect((await post("/api/games/g_rev/apply-live", { game: DEMO_GAME, baseVersion: 0 })).status).toBe(409); // not live yet
    const launched = await post("/api/games/g_rev/launch");
    expect(launched.status).toBe(200);
    expect((await post("/api/games/g_rev/apply-live", { game: DEMO_GAME })).status).toBe(400); // no base version
    for (const a of [...OPEN, { type: "question.edit", text: "Corrigée en régie ?" } as const]) s.runtime.submit(a, CTL, null);
    const stale = await post("/api/games/g_rev/apply-live", { game: DEMO_GAME, baseVersion: 0 });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(await stale.json())).toContain("a changé depuis");
    const live = (await (await fetch(`${base}/api/live/game?t=${t}`)).json()) as { game: typeof DEMO_GAME; gameVersion: number }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- test-only
    expect(live.game.questions.find((q) => q.id === "q_capital_fr")?.prompt.text).toBe("Corrigée en régie ?");
    const ok = await post("/api/games/g_rev/apply-live", { game: { ...live.game, title: "Renommée en direct" }, baseVersion: live.gameVersion });
    expect(ok.status).toBe(200);
    expect(s.runtime.current.state.game.title).toBe("Renommée en direct");
  });

  it("a display name made only of invisible characters is refused over WS", async () => {
    const s = await boot();
    const c = await rawSocket(s);
    hello(c.ws, tokenOf(s, "control"));
    await wait(80);
    c.ws.send(JSON.stringify({ t: "intent", key: "k_rev_name_1", action: { type: "player.add", participantId: "p_9", displayName: "​​", channel: "seat", seat: 1 } }));
    await wait(120);
    expect(c.messages.find((m) => m["t"] === "ack" && m["key"] === "k_rev_name_1")).toMatchObject({ ok: false, code: "invalid" });
    c.ws.close();
  });
});

const old = (id: string) => RETIRED_TEMPLATES.find((t) => t.id === id)?.game;

describe("cleanup of older templates (ADR-0015)", () => {
  it("an untouched copy of a retired template is removed, an edited one is kept, a replaced one is updated", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "quiz-rev-"));
    dirs.push(dataDir);
    mkdirSync(join(dataDir, "games"), { recursive: true });
    writeFileSync(join(dataDir, "games", "g_modele_texte.json"), JSON.stringify(old("g_modele_texte")));
    writeFileSync(join(dataDir, "games", "g_modele_ordre.json"), JSON.stringify({ ...old("g_modele_ordre"), title: "Mon ordre à moi" }));
    writeFileSync(join(dataDir, "games", "g_modele_sondage.json"), JSON.stringify(old("g_modele_sondage")));
    const s = await startServer({ ...Config.parse({ dataDir, host: "127.0.0.1", logLevel: "fatal" }), port: 0 });
    servers.push(s);
    expect(existsSync(join(dataDir, "games", "g_modele_texte.json"))).toBe(false);
    expect(existsSync(join(dataDir, "games", "g_modele_ordre.json"))).toBe(true);
    const lib = new GameLibrary(dataDir);
    expect(lib.get("g_modele_ordre")?.format.rounds[0]?.mechanic).toBe("mixed"); // kept, read as « Mixte »
    expect(lib.get("g_modele_sondage")?.title).toMatch(/famille en or/i);
  });

  it("a truncated library file never stops the server from starting", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "quiz-rev-"));
    dirs.push(dataDir);
    mkdirSync(join(dataDir, "games"), { recursive: true });
    writeFileSync(join(dataDir, "games", "g_modele_qcm.json"), '{"schemaVersion":1,"title":"cou');
    const s = await startServer({ ...Config.parse({ dataDir, host: "127.0.0.1", logLevel: "fatal" }), port: 0 });
    servers.push(s);
    expect(new GameLibrary(dataDir).get("g_modele_qcm")).toBeNull();
    expect(existsSync(join(dataDir, "games", "g_modele_qcm.json"))).toBe(true); // left as is
  });
});

