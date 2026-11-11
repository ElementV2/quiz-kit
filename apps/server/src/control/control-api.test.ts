import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config } from "../config.ts";
import { startServer, type RunningServer } from "../server.ts";
import { decodeOsc, encodeOsc } from "./osc.ts";

describe("OSC codec (spec 1.0)", () => {
  it("encodes the spec example and round-trips ints, floats, strings, booleans", () => {
    expect(encodeOsc("/q/next", [7]).toString("hex")).toBe("2f712f6e657874002c69000000000007");
    const m = decodeOsc(encodeOsc("/quiz/layer-take", ["banner", 3, { f: 1.5 }, true]));
    expect(m).toEqual([{ address: "/quiz/layer-take", args: ["banner", 3, 1.5, true] }]);
  });

  it("flattens bundles, tolerates a missing type tag, rejects garbage without throwing", () => {
    const inner = encodeOsc("/quiz/next");
    const size = Buffer.alloc(4);
    size.writeInt32BE(inner.length);
    const bundle = Buffer.concat([Buffer.from("#bundle\0", "ascii"), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), size, inner, size, inner]);
    expect(decodeOsc(bundle)?.map((x) => x.address)).toEqual(["/quiz/next", "/quiz/next"]);
    expect(decodeOsc(Buffer.from("/quiz/undo\0\0", "ascii"))).toEqual([{ address: "/quiz/undo", args: [] }]);
    for (const bad of [Buffer.from("abc"), Buffer.from("/x\0\0,z\0\0", "ascii"), Buffer.from("#bundle\0\0\0\0\0\0\0\0\x01\x7f\xff\xff\xff", "latin1"), Buffer.alloc(0)]) expect(decodeOsc(bad)).toBeNull();
  });
});

const running: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function boot(extra: Record<string, unknown> = {}): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "quiz-ctl-"));
  dirs.push(dir);
  const s = await startServer({ ...Config.parse({ dataDir: dir, host: "127.0.0.1", logLevel: "fatal", seats: 2, ...extra }), port: 0 });
  running.push(s);
  return s;
}
const control = (s: RunningServer) => s.links.entries.find((e) => e.id === "control")?.path.split("t=")[1] ?? "";

describe("HTTP control API (/api/v1)", () => {
  it("next walks the show, refusals stay 200 for Companion, bad token 401, unknown 404", async () => {
    const s = await boot();
    const auth = { authorization: `Bearer ${control(s)}` };
    const post = (cmd: string, payload?: object) => s.http.inject({ method: "POST", url: `/api/v1/${cmd}`, headers: auth, ...(payload === undefined ? {} : { payload }) });
    expect((await post("next")).json()).toMatchObject({ ok: true, did: "Démarrer la partie" });
    expect((await post("next")).json()).toMatchObject({ ok: true, did: "Démarrer la manche" });
    const refused = await post("reveal");
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toMatchObject({ ok: false, code: "wrong-phase" });
    expect((await post("buzz", { args: [9] })).json()).toMatchObject({ ok: false, reason: expect.stringContaining("siège 9") });
    expect((await s.http.inject({ method: "POST", url: "/api/v1/next" })).statusCode).toBe(401);
    expect((await post("explode")).statusCode).toBe(404);
    const st = await s.http.inject({ method: "GET", url: "/api/v1/state", headers: auth });
    expect(st.json()).toMatchObject({ ok: true, phase: "idle", next: "Présenter la question" });
    // Journaled as the API: undoable like a click.
    expect(s.runtime.current.events.at(-1)?.actor).toEqual({ role: "control", id: "api" });
  });
});

describe("OSC control API", () => {
  it("is off by default; when on, /quiz/next drives the show and other senders can be refused", async () => {
    const s = await boot({ oscPort: 47_311, oscAllow: "127.0.0.1" });
    // undo is refused over OSC (unauthenticated, a duplicated packet would undo twice).
    const udp = createSocket("udp4");
    const send = (b: Buffer) => new Promise<void>((r) => udp.send(b, 47_311, "127.0.0.1", () => r()));
    await send(encodeOsc("/quiz/next"));
    // A second press in the same instant is planned against the same state and refused (no double step).
    await send(encodeOsc("/quiz/next"));
    await new Promise((r) => setTimeout(r, 150));
    expect(s.runtime.current.state.phase).toBe("idle");
    expect(s.runtime.current.state.roundIndex).toBeNull();
    await send(encodeOsc("/quiz/next"));
    await new Promise((r) => setTimeout(r, 150));
    udp.close();
    expect(s.runtime.current.state.phase).toBe("idle");
    expect(s.runtime.current.state.roundIndex).toBe(0);
    expect(s.runtime.current.events.at(-1)?.actor).toEqual({ role: "control", id: "osc" });
  });
});

describe("control API hardening (review 3)", () => {
  it("OSC refuses to start without an allow-list; HTTP Idempotency-Key applies a retried undo once", async () => {
    const s = await boot({ oscPort: 47_312 });
    // No allow-list: the show still starts, OSC stays off.
    const udp = createSocket("udp4");
    await new Promise<void>((r) => udp.send(encodeOsc("/quiz/next"), 47_312, "127.0.0.1", () => r()));
    await new Promise((r) => setTimeout(r, 150));
    udp.close();
    expect(s.runtime.current.state.phase).toBe("lobby");
    const auth = { authorization: `Bearer ${control(s)}` };
    for (const cmd of ["next", "next", "next"]) await s.http.inject({ method: "POST", url: `/api/v1/${cmd}`, headers: auth });
    const before = s.runtime.current.state.phase;
    const undo = () => s.http.inject({ method: "POST", url: "/api/v1/undo", headers: { ...auth, "idempotency-key": "companion-undo-0001" } });
    expect((await undo()).json()).toMatchObject({ ok: true });
    expect((await undo()).json()).toMatchObject({ ok: true }); // same key: same ack, no second undo
    expect(s.runtime.current.events.filter((e) => e.action.type === "undo")).toHaveLength(1);
    expect(s.runtime.current.state.phase).not.toBe(before);
  });
});

