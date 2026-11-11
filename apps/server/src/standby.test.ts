import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TEXT_GAME } from "@quiz/schema";
import { Config } from "./config.ts";
import { startServer, type RunningServer } from "./server.ts";

const running: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function boot(extra: Record<string, unknown> = {}): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "quiz-sb-"));
  dirs.push(dir);
  const s = await startServer({ ...Config.parse({ dataDir: dir, host: "127.0.0.1", logLevel: "fatal", seats: 2, ...extra }), port: 0 });
  running.push(s);
  return s;
}
const controlToken = (s: RunningServer) => s.links.entries.find((e) => e.id === "control")?.path.split("t=")[1] ?? "";
const CONTROL = { role: "control", id: "op" } as const;
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
};

describe("hot standby", () => {
  it("mirrors the primary's journal exactly, refuses intents, follows a game switch, takes over when promoted", async () => {
    const primary = await boot();
    const standby = await boot({ standbyOf: `http://127.0.0.1:${primary.port}`, standbyToken: controlToken(primary) });
    for (const a of [{ type: "game.start" }, { type: "round.start" }, { type: "player.add", participantId: "p_1", displayName: "Ana", channel: "play" }, { type: "question.present" }] as const) primary.runtime.submit(a, CONTROL, null);
    primary.runtime.submit({ type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["b"] } }, CONTROL, null);
    await until(() => standby.runtime.current.state.lastSeq === primary.runtime.current.state.lastSeq);
    expect(standby.runtime.session.id).toBe(primary.runtime.session.id);
    expect(standby.runtime.current.state).toEqual(primary.runtime.current.state);
    // Read-only until promoted; its own control room sees the status.
    expect(standby.runtime.submit({ type: "question.lock" }, CONTROL, null)).toMatchObject({ ok: false, reason: expect.stringContaining("secours") });
    const st = await standby.http.inject({ method: "GET", url: `/api/standby?t=${controlToken(standby)}` });
    expect(st.json()).toMatchObject({ standby: { mode: "standby", lag: 0, error: null } });
    expect((await standby.http.inject({ method: "POST", url: `/api/session?t=${controlToken(standby)}`, payload: { game: DEMO_TEXT_GAME } })).statusCode).toBe(409);

    // The primary switches game: the standby follows the new session.
    primary.newSession(DEMO_TEXT_GAME);
    for (const a of [{ type: "game.start" }, { type: "round.start" }] as const) primary.runtime.submit(a, CONTROL, null);
    await until(() => standby.runtime.session.id === primary.runtime.session.id && standby.runtime.current.state.lastSeq === primary.runtime.current.state.lastSeq);
    expect(standby.runtime.current.state.game.title).toBe(DEMO_TEXT_GAME.title);

    // Primary lost: promote the standby, it continues from the very same state.
    await primary.close();
    running.splice(running.indexOf(primary), 1);
    // Split-brain guard: the primary answered a moment ago → refused unless forced.
    const refused = await standby.http.inject({ method: "POST", url: `/api/standby/promote?t=${controlToken(standby)}`, payload: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("répond encore");
    const promoted = await standby.http.inject({ method: "POST", url: `/api/standby/promote?t=${controlToken(standby)}`, payload: { force: true } });
    expect(promoted.json()).toMatchObject({ standby: { mode: "promoted" } });
    // Once promoted, replication is refused outright.
    expect(() => standby.runtime.replicate([])).toThrow(/plus en secours/);
    expect(standby.runtime.submit({ type: "question.present" }, CONTROL, null)).toMatchObject({ ok: true });
    expect(standby.runtime.current.state.phase).toBe("open");
    expect((await standby.http.inject({ method: "POST", url: `/api/standby/promote?t=${controlToken(standby)}`, payload: { force: true } })).statusCode).toBe(409);
  });

  it("reports a wrong primary token instead of silently drifting", async () => {
    const primary = await boot();
    const standby = await boot({ standbyOf: `http://127.0.0.1:${primary.port}`, standbyToken: "pas-le-bon-jeton" });
    const status = async () => (await standby.http.inject({ method: "GET", url: `/api/standby?t=${controlToken(standby)}` })).json();
    for (let i = 0; i < 40 && (await status()).standby.error === null; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await status()).toMatchObject({ standby: { mode: "standby", error: expect.stringContaining("refusé") } });
  });
});

describe("hot standby divergence (review 4 I2)", () => {
  it("stops following (and says so) when its journal forked from the primary's", async () => {
    const primary = await boot();
    const standby = await boot({ standbyOf: `http://127.0.0.1:${primary.port}`, standbyToken: controlToken(primary) });
    primary.runtime.submit({ type: "game.start" }, CONTROL, null);
    await until(() => standby.runtime.current.state.lastSeq === primary.runtime.current.state.lastSeq);
    // Fork: the standby decides one action on its own (as if once promoted by mistake), then the primary moves on.
    standby.runtime.setStandby(false);
    expect(standby.runtime.submit({ type: "team.add", teamId: "t_x", name: "X", color: "#111111" }, CONTROL, null)).toMatchObject({ ok: true });
    standby.runtime.setStandby(true);
    primary.runtime.submit({ type: "round.start" }, CONTROL, null);
    const status = async () => (await standby.http.inject({ method: "GET", url: `/api/standby?t=${controlToken(standby)}` })).json();
    for (let i = 0; i < 40 && (await status()).standby.diverged === null; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await status()).standby.diverged).toContain("journal différent");
    expect(standby.runtime.current.state.teams.map((t) => t.id)).toEqual(["t_x"]); // nothing of the primary mixed in
    // Promotion of a diverged standby is refused (review 5 I4) — the primary is alive anyway (contact kept).
    const res = await standby.http.inject({ method: "POST", url: `/api/standby/promote?t=${controlToken(standby)}`, payload: {} });
    expect(res.statusCode).toBe(409);
  });
});
