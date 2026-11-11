import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config } from "../config.ts";
import { startServer, type RunningServer } from "../server.ts";
import { VmixConfig, VmixDriver } from "./driver.ts";

const running: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CONTROL = { role: "control", id: "op" } as const;
const CONFIG = VmixConfig.parse({
  url: "http://192.168.1.40:8088",
  input: "Quiz Titre",
  fields: { "Question.Text": "question.text", "Num.Text": "question.number", "A.Text": "option.1", "B.Text": "option.2", "Reponse.Text": "answer", "Leader.Text": "leader.name" },
  overlay: 1,
});

describe("vMix titles driver", () => {
  it("sends only changed fields, one at a time, with the documented SetText / Overlay calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiz-vmix-"));
    dirs.push(dir);
    const s = await startServer({ ...Config.parse({ dataDir: dir, host: "127.0.0.1", logLevel: "fatal", seats: 1 }), port: 0 });
    running.push(s);
    const calls: URLSearchParams[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fake: typeof fetch = async (input) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      expect(url.origin + url.pathname).toBe("http://192.168.1.40:8088/api/");
      calls.push(url.searchParams);
      return new Response("", { status: 200 });
    };
    const vmix = new VmixDriver(fake);
    vmix.attach(s.runtime, CONFIG);
    for (const a of [{ type: "game.start" }, { type: "round.start" }, { type: "player.add", participantId: "p_1", displayName: "Ana", channel: "play" }, { type: "question.present" }] as const) s.runtime.submit(a, CONTROL, null);
    await new Promise((r) => setTimeout(r, 120));
    await vmix.flush();
    const set = (field: string) => calls.filter((c) => c.get("Function") === "SetText" && c.get("SelectedName") === field).map((c) => c.get("Value"));
    expect(set("Question.Text").at(-1)).toBe("Quelle est la capitale de la France ?");
    expect(set("Num.Text").at(-1)).toBe("1 / 3");
    expect(set("Reponse.Text").at(-1)).toBe(""); // not revealed yet
    expect(calls.some((c) => c.get("Function") === "OverlayInput1In" && c.get("Input") === "Quiz Titre")).toBe(true);
    expect(maxInFlight).toBe(1);
    const before = calls.length;
    s.runtime.submit({ type: "question.open" }, CONTROL, null);
    await new Promise((r) => setTimeout(r, 60));
    await vmix.flush();
    expect(calls.length).toBe(before); // nothing changed on the title
    s.runtime.submit({ type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["b"] } }, CONTROL, null);
    s.runtime.submit({ type: "question.lock" }, CONTROL, null);
    s.runtime.submit({ type: "question.reveal" }, CONTROL, null);
    await new Promise((r) => setTimeout(r, 60));
    await vmix.flush();
    expect(set("Reponse.Text").at(-1)).toBe("Paris");
    expect(set("Leader.Text").at(-1)).toBe("Ana");
    vmix.close();
  });

  it("reports vMix errors without throwing; the config is validated", async () => {
    expect(VmixConfig.safeParse({ url: "ftp://x", input: "a", fields: {} }).success).toBe(false);
    expect(VmixConfig.safeParse({ url: "http://x:8088", input: "a", fields: { "A.Text": "option.9" } }).success).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "quiz-vmix-"));
    dirs.push(dir);
    const s = await startServer({ ...Config.parse({ dataDir: dir, host: "127.0.0.1", logLevel: "fatal", seats: 1 }), port: 0 });
    running.push(s);
    const vmix = new VmixDriver(async () => { throw new Error("ECONNREFUSED"); });
    vmix.attach(s.runtime, { ...CONFIG, overlay: undefined });
    s.runtime.submit({ type: "game.start" }, CONTROL, null);
    await new Promise((r) => setTimeout(r, 60));
    await vmix.flush();
    expect(vmix.status).toMatchObject({ enabled: true, ok: false, lastError: expect.stringContaining("ECONNREFUSED") });
    vmix.close();
  });
});

describe("vMix recovery (review 4 I5)", () => {
  it("while vMix is down nothing stale piles up; once back, the current value is resent (retry)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiz-vmix-"));
    dirs.push(dir);
    const s = await startServer({ ...Config.parse({ dataDir: dir, host: "127.0.0.1", logLevel: "fatal", seats: 1 }), port: 0 });
    running.push(s);
    let up = false;
    const sent: string[] = [];
    const vmix = new VmixDriver(async (input) => {
      if (!up) throw new Error("ECONNREFUSED");
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (u.searchParams.get("SelectedName") === "Num.Text") sent.push(u.searchParams.get("Value") ?? "");
      return new Response("", { status: 200 });
    });
    vmix.attach(s.runtime, { ...CONFIG, overlay: undefined, fields: { "Num.Text": "question.number" } });
    for (const a of [{ type: "game.start" }, { type: "round.start" }, { type: "question.present" }] as const) s.runtime.submit(a, CONTROL, null);
    await new Promise((r) => setTimeout(r, 60));
    for (const a of [{ type: "question.open" }, { type: "question.lock" }, { type: "question.reveal" }, { type: "question.next" }, { type: "question.present" }] as const) s.runtime.submit(a, CONTROL, null);
    await new Promise((r) => setTimeout(r, 60));
    await vmix.flush();
    up = true;
    // The retry (2 s) sends the CURRENT value once — not the stale "1 / 3" queued while vMix was down.
    await new Promise((r) => setTimeout(r, 2300));
    await vmix.flush();
    expect(sent).toEqual(["2 / 3"]);
    vmix.close();
  });
});

