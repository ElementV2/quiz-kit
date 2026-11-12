import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_HINTS_GAME, type GameDocument, type Media } from "@quiz/schema";
import { Config } from "../config.ts";
import { startServer, type RunningServer } from "../server.ts";
import { MediaStore } from "./media-store.ts";
import { MAX_SIDE, TileCutter, tileBox } from "./tiles.ts";

const running: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("tileBox", () => {
  it("tiles cover the picture exactly, the remainder shared", () => {
    const boxes = Array.from({ length: 12 }, (_, i) => tileBox(101, 50, 4, 3, i));
    expect(boxes.reduce((n, b) => n + b.width * b.height, 0)).toBe(101 * 50);
    expect(boxes[0]).toEqual({ left: 0, top: 0, width: 25, height: 16 });
    expect(boxes[11]).toEqual({ left: 75, top: 33, width: 26, height: 17 });
  });
});

/** 2 × 2 picture, one colour per quarter: red, green / blue, white. */
const QUARTERS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]] as const;
async function quarters(): Promise<Buffer> {
  const raw = Buffer.alloc(40 * 30 * 3);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) raw.set(QUARTERS[(y < 15 ? 0 : 2) + (x < 20 ? 0 : 1)] ?? [0, 0, 0], (y * 40 + x) * 3);
  return sharp(raw, { raw: { width: 40, height: 30, channels: 3 } }).png().toBuffer();
}

describe("GET /api/tile/:question/:index (« Image dévoilée » on the tablets)", () => {
  it("serves only the uncovered tiles of the question on air, cut out of the picture; every tile once revealed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiz-tiles-"));
    dirs.push(dir);
    const s = await startServer({ ...Config.parse({ dataDir: dir, host: "127.0.0.1", logLevel: "fatal", seats: 0 }), port: 0 });
    running.push(s);
    const t = s.links.entries.find((x) => x.label === "Studio")?.path.split("t=")[1] ?? "";
    const up = await s.http.inject({ method: "POST", url: `/api/media?name=q.png&t=${t}`, headers: { "content-type": "image/png" }, payload: await quarters() });
    const pic = up.json<{ media: Media }>().media;
    const game: GameDocument = {
      ...DEMO_HINTS_GAME,
      questions: DEMO_HINTS_GAME.questions.map((q) => ({ ...q, prompt: { ...q.prompt, media: pic } })),
      format: { ...DEMO_HINTS_GAME.format, rounds: DEMO_HINTS_GAME.format.rounds.map((r) => ({ ...r, mechanic: "reveal-image", mechanicConfig: { cols: 2, rows: 2 } })) },
    };
    s.newSession(game);
    const ctl = { role: "control", id: "op" } as const;
    const tile = (q: string, i: number) => s.http.inject({ method: "GET", url: `/api/tile/${q}/${i}` });
    const qid = game.format.rounds[0]?.questions[0] ?? "";
    expect((await tile(qid, 0)).statusCode).toBe(404); // nothing on air
    for (const a of [{ type: "game.start" }, { type: "round.start" }, { type: "question.present" }] as const) s.runtime.submit(a, ctl, null);

    const view = s.runtime.view({ role: "player", participantId: "p_x" });
    expect(JSON.stringify(view)).not.toContain(pic.hash); // the tablet never learns the picture
    const m = view.mechanic;
    if (m?.mechanic !== "reveal-image") throw new Error("reveal-image view");
    expect(m.aspect).toBeCloseTo(40 / 30);
    expect(m.revealed).toHaveLength(1);
    const open = m.revealed[0] ?? -1;
    for (let i = 0; i < 4; i++) {
      const r = await tile(qid, i);
      expect(r.statusCode, `tile ${i}`).toBe(i === open ? 200 : 404);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
    const got = await tile(qid, open);
    expect(got.headers["content-type"]).toBe("image/webp");
    const { data, info } = await sharp(got.rawPayload).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([20, 15]);
    const expected = QUARTERS[open] ?? [];
    for (let c = 0; c < 3; c++) expect(Math.abs((data[c] ?? 0) - (expected[c] ?? 0))).toBeLessThan(12);
    expect((await tile("q_other", open)).statusCode).toBe(404);
    expect((await tile(qid, 9)).statusCode).toBe(404);
    expect((await tile(qid, -1)).statusCode).toBe(404);

    // A tile uncovered then undone is refused again.
    s.runtime.submit({ type: "element.reveal", index: 1 }, ctl, null);
    const two = s.runtime.view({ role: "control" }).mechanic;
    const extra = two?.mechanic === "reveal-image" ? two.revealed.find((i) => i !== open) ?? -1 : -1;
    expect((await tile(qid, extra)).statusCode).toBe(200);
    s.runtime.submit({ type: "undo" }, ctl, null);
    expect((await tile(qid, extra)).statusCode).toBe(404);

    for (const a of [{ type: "question.lock" }, { type: "question.reveal" }] as const) s.runtime.submit(a, ctl, null);
    for (let i = 0; i < 4; i++) expect((await tile(qid, i)).statusCode).toBe(200);
    // Next question: the tiles of the previous one are refused.
    for (const a of [{ type: "question.next" }, { type: "question.present" }] as const) s.runtime.submit(a, ctl, null);
    expect((await tile(qid, open)).statusCode).toBe(404);
  });
});

function store(): MediaStore {
  const dir = mkdtempSync(join(tmpdir(), "quiz-cut-"));
  dirs.push(dir);
  return new MediaStore(dir);
}

describe("TileCutter never breaks the show", () => {
  it("an unreadable picture: null, said once, not decoded again per request", async () => {
    const media = store();
    const meta = await media.put(Readable.from([Buffer.from("not a picture at all")]), "image/png", "x.png").catch(() => null);
    const warns: string[] = [];
    const cut = new TileCutter(media, (m) => warns.push(m));
    const hash = meta?.hash ?? "d".repeat(64);
    expect(await cut.cut({ hash, cols: 2, rows: 2, index: 0 })).toBeNull();
    expect(await cut.cut({ hash, cols: 2, rows: 2, index: 1 })).toBeNull();
    expect(warns.length).toBeLessThanOrEqual(1);
  });
  it("sharp that cannot load: null for every tile, one warning", async () => {
    const media = store();
    const meta = await media.put(Readable.from([await quarters()]), "image/png", "q.png");
    const warns: string[] = [];
    const cut = new TileCutter(media, (m) => warns.push(m), () => Promise.reject(new Error("no libvips")));
    for (let i = 0; i < 4; i++) expect(await cut.cut({ hash: meta.hash, cols: 2, rows: 2, index: i })).toBeNull();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("sharp");
  });
  it("a large photo: tiles cut from the picture reduced to MAX_SIDE", async () => {
    const media = store();
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    const meta = await media.put(Readable.from([big]), "image/jpeg", "big.jpg");
    const tileBytes = await new TileCutter(media).cut({ hash: meta.hash, cols: 4, rows: 3, index: 5 });
    const info = await sharp(tileBytes ?? Buffer.alloc(0)).metadata();
    expect([info.width, info.height]).toEqual([MAX_SIDE / 4, 1200 / 3]);
  });
});
