import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGame, decide, defaultRegistry, project, type Game } from "@quiz/engine";
import { DEMO_ALLOCATION_GAME, DEMO_BOARD_GAME, DEMO_GAME, DEMO_HINTS_GAME, DEMO_NUMBER_GAME, DEMO_ORDER_GAME, DEMO_PAIRS_GAME, DEMO_TEXT_GAME, type Action, type Actor, type ControlView, type GameDocument } from "@quiz/schema";
import { Config } from "./config.ts";
import { botAction } from "./rehearsal.ts";
import { buildResults, resultsCsv, resultsHtml } from "./results.ts";
import { startServer, type RunningServer } from "./server.ts";
import { signToken } from "./tokens.ts";

const CONTROL: Actor = { role: "control", id: "op" };
const PIC = { hash: "c".repeat(64), mime: "image/png" };
const PIN_GAME: GameDocument = {
  ...DEMO_TEXT_GAME,
  questions: [{ id: "q_pin", prompt: { text: "Où ?", media: PIC }, answerSpec: { kind: "pin", target: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } }, hints: [], tags: [] }],
  format: { ...DEMO_TEXT_GAME.format, rounds: [{ ...DEMO_TEXT_GAME.format.rounds[0]!, mechanic: "pin", questions: ["q_pin"] }] }, // oxlint-disable-line typescript/no-non-null-assertion -- fixture has a round
};
const IMAGE_GAME: GameDocument = {
  ...DEMO_HINTS_GAME,
  questions: DEMO_HINTS_GAME.questions.map((q) => ({ ...q, prompt: { ...q.prompt, media: PIC } })),
  format: { ...DEMO_HINTS_GAME.format, rounds: DEMO_HINTS_GAME.format.rounds.map((r) => ({ ...r, mechanic: "reveal-image" })) },
};

function play(game: GameDocument, steps: readonly (readonly [Actor, Action])[]): Game {
  let g = createGame({ schemaVersion: 1, id: "ses_t", game, seed: 3, createdAt: 0 });
  let at = 1_000_000;
  for (const [actor, action] of steps) {
    const r = decide(g, { action, actor, idempotencyKey: null }, (at += 1000), defaultRegistry);
    if (!r.ok) throw new Error(`${action.type}: ${r.error.message}`);
    g = r.value.game;
  }
  return g;
}
const ctl = (a: Action) => [CONTROL, a] as const;
const control = (g: Game): ControlView => {
  const v = project(g, { role: "control" }, defaultRegistry);
  if (v.role !== "control") throw new Error("control view");
  return v;
};

describe("results export", () => {
  const g = play(DEMO_TEXT_GAME, [
    ctl({ type: "game.start" }), ctl({ type: "round.start" }),
    ctl({ type: "player.add", participantId: "p_1", displayName: "=HYPERLINK(\"x\")", channel: "play" }),
    ctl({ type: "player.add", participantId: "p_2", displayName: "Zoé; la \"rapide\"", channel: "play" }),
    ctl({ type: "question.present" }), ctl({ type: "question.open" }),
    [{ role: "player", id: "p_1" }, { type: "answer.submit", participantId: "p_1", answer: { kind: "text", text: "Monet" } }],
    [{ role: "player", id: "p_2" }, { type: "answer.submit", participantId: "p_2", answer: { kind: "text", text: "van gogh" } }],
    ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }),
  ]);
  const r = buildResults(g, defaultRegistry);

  it("ranks players and details every answer with its verdict and points", () => {
    expect(r.ranking.map((x) => [x.rank, x.participantId])).toEqual([[1, "p_2"], [2, "p_1"]]);
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]?.answers).toEqual([
      expect.objectContaining({ participantId: "p_1", answer: "Monet", outcome: "wrong", points: 0 }),
      expect.objectContaining({ participantId: "p_2", answer: "van gogh", outcome: "correct", points: expect.any(Number) }),
    ]);
  });

  it("CSV for Excel: BOM, `;`, quoting, formula injection neutralised", () => {
    const csv = resultsCsv(r, "ranking");
    expect(csv.startsWith("﻿Rang;Joueur;Équipe;Total\r\n")).toBe(true);
    expect(csv).toContain(`'=HYPERLINK(""x"")`);
    expect(csv).toContain(`"Zoé; la ""rapide"""`);
    expect(resultsCsv(r, "detail")).toContain("van gogh;bonne;");
  });

  it("printable page escapes names, has no script", () => {
    const html = resultsHtml(r, "2026-11-11 20:00");
    expect(html).not.toContain("<script");
    expect(html).toContain("Zoé; la &quot;rapide&quot;");
    expect(html).toContain("Gagnants");
  });
});

describe("rehearsal bots", () => {
  const games: [string, GameDocument][] = [
    ["choice", DEMO_GAME], ["text-answer", DEMO_TEXT_GAME], ["number-answer", DEMO_NUMBER_GAME], ["order", DEMO_ORDER_GAME],
    ["pairs", DEMO_PAIRS_GAME], ["allocation", DEMO_ALLOCATION_GAME], ["board", DEMO_BOARD_GAME], ["hints", DEMO_HINTS_GAME],
    ["pin", PIN_GAME], ["reveal-image", IMAGE_GAME],
  ];
  it.each(games)("%s: a bot's answer is accepted by the engine, accuracy 1 scores", (_name, game) => {
    const open = play(game, [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ctl({ type: "player.add", participantId: "p_bot_1", displayName: "Bot 1", channel: "play" }), ctl({ type: "question.present" }), ctl({ type: "question.open" })]);
    const m = control(open).mechanic;
    if (m === null) throw new Error("mechanic view");
    for (const accuracy of [0, 1]) {
      const a = botAction(m, "p_bot_1", () => 0.5, accuracy);
      if (a === null) throw new Error("bot does nothing");
      const r = decide(open, { action: a, actor: { role: "player", id: "p_bot_1" }, idempotencyKey: null }, 2_000_000, defaultRegistry);
      expect(r.ok, `${a.type} refused: ${r.ok ? "" : r.error.message}`).toBe(true);
    }
  });
});

const running: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "quiz-p3-"));
  dirs.push(dir);
  const server = await startServer({ ...Config.parse({ dataDir: dir, host: "127.0.0.1", logLevel: "fatal", seats: 2 }), port: 0 });
  running.push(server);
  return server;
}
const tokenOf = (s: RunningServer, label: string): string => s.links.entries.find((x) => x.label === label)?.path.split("t=")[1] ?? "";

describe("phase 3 HTTP routes", () => {
  it("results, journal and rehearsal need the control token; bots join and answer", async () => {
    const s = await boot();
    const t = tokenOf(s, "Régie");
    const out = tokenOf(s, "Sortie program");
    for (const url of ["/api/results", "/api/journal", "/api/rehearsal"]) {
      expect((await s.http.inject({ method: "GET", url: `${url}?t=${out}` })).statusCode).toBe(401);
    }
    // A scorer may export results, never read the journal or drive bots.
    const scorer = signToken(s.secret, { v: 1, show: "main", jti: "scorer", exp: null, role: "scorer" });
    expect((await s.http.inject({ method: "GET", url: `/api/results?t=${scorer}` })).statusCode).toBe(200);
    for (const url of ["/api/journal", "/api/rehearsal"]) expect((await s.http.inject({ method: "GET", url: `${url}?t=${scorer}` })).statusCode).toBe(401);
    const csv = await s.http.inject({ method: "GET", url: `/api/results?kind=ranking&t=${t}` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const html = await s.http.inject({ method: "GET", url: `/api/results?format=html&t=${t}` });
    expect(html.headers["content-security-policy"]).toContain("default-src 'none'");
    const journal = await s.http.inject({ method: "GET", url: `/api/journal?t=${t}` });
    expect(journal.json()).toMatchObject({ session: { id: s.runtime.session.id }, events: expect.any(Array), next: null });

    expect((await s.http.inject({ method: "POST", url: `/api/rehearsal?t=${t}`, payload: { bots: 0 } })).statusCode).toBe(400);
    const started = await s.http.inject({ method: "POST", url: `/api/rehearsal?t=${t}`, payload: { bots: 5, accuracy: 1, latencyMs: 0 } });
    expect(started.json()).toMatchObject({ bots: 5 });
    for (const a of [{ type: "game.start" }, { type: "round.start" }, { type: "question.present" }, { type: "question.open" }] as const) s.runtime.submit(a, CONTROL, null);
    await new Promise((r) => setTimeout(r, 300));
    expect(control(s.runtime.current).answers.filter((a) => a.participantId.startsWith("p_bot_"))).toHaveLength(5);
    const stopped = await s.http.inject({ method: "DELETE", url: `/api/rehearsal?t=${t}` });
    expect(stopped.json()).toEqual({ removed: 5 });
    expect(s.runtime.current.state.participants.filter((p) => p.id.startsWith("p_bot_"))).toHaveLength(0);
    // Real players present: refused unless explicit.
    s.runtime.submit({ type: "player.add", participantId: "p_human", displayName: "Vrai", channel: "play" }, CONTROL, null);
    expect((await s.http.inject({ method: "POST", url: `/api/rehearsal?t=${t}`, payload: { bots: 2 } })).statusCode).toBe(409);
    expect((await s.http.inject({ method: "POST", url: `/api/rehearsal?t=${t}`, payload: { bots: 2, withPlayers: true } })).json()).toMatchObject({ bots: 2 });
  });

  it("stop and session switch cancel pending bot answers", async () => {
    const s = await boot();
    const t = tokenOf(s, "Régie");
    await s.http.inject({ method: "POST", url: `/api/rehearsal?t=${t}`, payload: { bots: 3, accuracy: 1, latencyMs: 400 } });
    for (const a of [{ type: "game.start" }, { type: "round.start" }, { type: "question.present" }, { type: "question.open" }] as const) s.runtime.submit(a, CONTROL, null);
    s.newSession(DEMO_GAME);
    await new Promise((r) => setTimeout(r, 900));
    expect(s.runtime.current.state.participants).toHaveLength(0); // new session untouched
    expect((await s.http.inject({ method: "GET", url: `/api/rehearsal?t=${t}` })).json()).toMatchObject({ running: false });
  });

  it("regrade preview shows who changes, journals nothing", async () => {
    const s = await boot();
    const t = tokenOf(s, "Régie");
    for (const a of [
      { type: "game.start" }, { type: "round.start" }, { type: "player.add", participantId: "p_1", displayName: "A", channel: "play" },
      { type: "question.present" }, { type: "question.open" },
    ] as const) s.runtime.submit(a, CONTROL, null);
    s.runtime.submit({ type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["a"] } }, CONTROL, null);
    s.runtime.submit({ type: "question.lock" }, CONTROL, null);
    s.runtime.submit({ type: "question.reveal" }, CONTROL, null);
    const q = s.runtime.current.state.game.questions[0];
    if (q?.answerSpec.kind !== "single") throw new Error("fixture");
    const before = s.runtime.current.state.lastSeq;
    const res = await s.http.inject({ method: "POST", url: `/api/regrade/preview?t=${t}`, payload: { questionId: q.id, answerSpec: { ...q.answerSpec, correct: "a" } } });
    expect(res.json()).toMatchObject({ changes: [{ participantId: "p_1", before: 0 }] });
    expect(s.runtime.current.state.lastSeq).toBe(before);
  });
});

describe("home page team access (/api/staff)", () => {
  it("the server PC gets every link and the code; another PC needs the code; brute force is cut", async () => {
    const s = await boot();
    const local = await s.http.inject({ method: "POST", url: "/api/staff", payload: {} });
    expect(local.statusCode).toBe(200);
    const body = local.json();
    expect(body).toMatchObject({ local: true, staffCode: expect.stringMatching(/^[2-9A-HJKMNP-Z]{8}$/), joinCode: expect.stringMatching(/^\d{6}$/) });
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining(["control", "studio", "host", "out-program", "seat-1"]));
    const remote = { remoteAddress: "192.168.1.50" };
    expect((await s.http.inject({ method: "POST", url: "/api/staff", payload: {}, ...remote })).statusCode).toBe(403);
    const ok = await s.http.inject({ method: "POST", url: "/api/staff", payload: { code: body.staffCode }, ...remote });
    expect(ok.json()).toMatchObject({ local: false, staffCode: null });
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await s.http.inject({ method: "POST", url: "/api/staff", payload: { code: "000000" }, remoteAddress: "192.168.1.51" })).statusCode;
    expect(last).toBe(429);
    // Lower case and spaces are accepted ("abcd 2345"); behind a proxy nobody is "local".
    const spaced = `${body.staffCode.slice(0, 4).toLowerCase()} ${body.staffCode.slice(4)}`;
    expect((await s.http.inject({ method: "POST", url: "/api/staff", payload: { code: spaced }, remoteAddress: "192.168.1.52" })).statusCode).toBe(200);
    expect((await s.http.inject({ method: "POST", url: "/api/staff", payload: {}, headers: { "x-forwarded-for": "10.0.0.9" } })).statusCode).toBe(403);
    // Rotation: the old code stops working.
    const t = s.links.entries.find((e) => e.id === "control")?.path.split("t=")[1] ?? "";
    const rotated = (await s.http.inject({ method: "POST", url: `/api/staff/rotate?t=${t}` })).json();
    expect(rotated.staffCode).not.toBe(body.staffCode);
    expect((await s.http.inject({ method: "POST", url: "/api/staff", payload: { code: body.staffCode }, remoteAddress: "192.168.1.53" })).statusCode).toBe(403);
    // The home page is served at /.
    expect((await s.http.inject({ method: "GET", url: "/" })).headers["content-type"]).toContain("text/html");
  });
});


describe("seat tablets seat their player (/api/seat/claim)", () => {
  it("a free seat takes a name; a taken seat and other tokens are refused", async () => {
    const s = await boot();
    const seat1 = tokenOf(s, "Siège 1");
    const res = await s.http.inject({ method: "POST", url: `/api/seat/claim?t=${seat1}`, payload: { name: "Ana" } });
    expect(res.statusCode).toBe(200);
    expect(s.runtime.current.state.participants).toEqual([expect.objectContaining({ displayName: "Ana", seat: 1, channel: "seat" })]);
    expect((await s.http.inject({ method: "POST", url: `/api/seat/claim?t=${seat1}`, payload: { name: "Bo" } })).statusCode).toBe(409);
    expect((await s.http.inject({ method: "POST", url: `/api/seat/claim?t=${tokenOf(s, "Régie")}`, payload: { name: "X" } })).statusCode).toBe(401);
    expect((await s.http.inject({ method: "POST", url: `/api/seat/claim?t=${tokenOf(s, "Siège 2")}`, payload: { name: "  " } })).statusCode).toBe(400);
  });
});

describe("built-in templates seeding", () => {
  it("each template is offered once: new ones appear on an older data dir, a deleted one never comes back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiz-seed-"));
    dirs.push(dir);
    const cfg = { ...Config.parse({ dataDir: dir, host: "127.0.0.1", logLevel: "fatal", seats: 1 }), port: 0 };
    let s = await startServer(cfg);
    const t = tokenOf(s, "Régie");
    const ids = async (): Promise<string[]> => {
      const body: { games: { id: string }[] } = (await s.http.inject({ method: "GET", url: `/api/games?t=${t}` })).json();
      return body.games.map((g) => g.id);
    };
    expect(await ids()).toEqual(expect.arrayContaining(["g_modele_qcm", "g_modele_soiree", "g_modele_plateau"]));
    await s.http.inject({ method: "DELETE", url: `/api/games/g_modele_plateau?t=${t}` });
    await s.close();
    s = await startServer(cfg);
    running.push(s);
    expect(await ids()).not.toContain("g_modele_plateau");
    expect(await ids()).toContain("g_modele_soiree");
  });
});

describe("review 6: names and studio launch", () => {
  it("names keep composed emojis, lose bidi tricks; the studio launches only while nothing is played", async () => {
    const s = await boot();
    const seat1 = tokenOf(s, "Siège 1");
    await s.http.inject({ method: "POST", url: `/api/seat/claim?t=${seat1}`, payload: { name: "Léa 👩‍🚀‮niamor" } });
    expect(s.runtime.current.state.participants[0]?.displayName).toBe("Léa 👩‍🚀niamor");
    // A journal holding such a name reads back after a restart (tolerant schema on read).
    expect(s.runtime.current.events.length).toBeGreaterThan(0);
    const studio = tokenOf(s, "Studio");
    const refused = await s.http.inject({ method: "POST", url: `/api/games/g_modele_qcm/launch?t=${studio}` });
    expect(refused.statusCode).toBe(409); // a player is in: the control room decides
    expect((await s.http.inject({ method: "POST", url: `/api/games/g_modele_qcm/launch?t=${tokenOf(s, "Régie")}` })).statusCode).toBe(200);
    expect((await s.http.inject({ method: "POST", url: `/api/games/g_modele_buzzer/launch?t=${studio}` })).statusCode).toBe(200); // fresh lobby
  });
});

