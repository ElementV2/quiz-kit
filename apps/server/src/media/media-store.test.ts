import { spawnSync } from "node:child_process";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_THEME, DEMO_GAME, Scene, Theme } from "@quiz/schema";
import { MediaStore, gameMediaHashes, lookMediaHashes } from "./media-store.ts";
import { PreloadCache, preloadFor } from "./preload.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "quiz-media-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const gen = (args: string[], out: string): string => {
  const path = join(dir, out);
  const r = spawnSync("ffmpeg", ["-y", "-v", "error", ...args, path]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return path;
};

describe.skipIf(!hasFfmpeg)("MediaStore (ffmpeg / ffprobe)", () => {
  const store = new MediaStore(join(dir, "data"));

  it("stores by SHA-256, probes dimensions, dedupes identical bytes", async () => {
    const png = gen(["-f", "lavfi", "-i", "color=c=red:s=320x200", "-frames:v", "1"], "red.png");
    const a = await store.put(createReadStream(png), "image/png", "red.png");
    expect(a).toMatchObject({ mime: "image/png", w: 320, h: 200 });
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    const b = await store.put(createReadStream(png), "image/png", "copie.png");
    expect(b.hash).toBe(a.hash);
    expect(store.pathOf(a.hash)).not.toBeNull();
  });

  it("converts audio that is not 48 kHz to WAV 48 kHz (doc 07)", async () => {
    const wav = gen(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1"], "a44.wav");
    const m = await store.put(createReadStream(wav), "audio/wav", "a44.wav");
    expect(m.mime).toBe("audio/wav");
    expect(m.convertedFrom).toMatch(/^[0-9a-f]{64}$/);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", store.pathOf(m.hash) ?? ""]);
    expect(String(probe.stdout).trim()).toBe("48000");
  });

  it("converts a ProRes 4444 stinger with alpha to WebM VP9 keeping alpha", async () => {
    const mov = gen(["-f", "lavfi", "-i", "color=c=black@0.0:s=160x90:d=1,format=yuva444p10le", "-c:v", "prores_ks", "-profile:v", "4444"], "stinger.mov");
    const m = await store.put(createReadStream(mov), "video/quicktime", "stinger.mov");
    expect(m).toMatchObject({ mime: "video/webm", w: 160, h: 90 });
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream_tags=alpha_mode", "-of", "csv=p=0", store.pathOf(m.hash) ?? ""]);
    expect(String(probe.stdout).trim()).toBe("1");
  }, 30_000);

  it("refuses formats browsers cannot play and it cannot convert", async () => {
    await expect(store.put(Readable.from([Buffer.from("MZ...")]), "application/x-msdownload", "x.exe")).rejects.toThrow(/non pris en charge/);
  });
});

const h = (c: string): string => c.repeat(64);

const zone = (text: string) => ({ id: "z", type: "text" as const, rect: { x: 0, y: 0, w: 10, h: 10 }, props: { text }, style: {}, states: {} });

describe("gameMediaHashes", () => {
  it("collects prompt and option media, deduplicated", () => {
    const game = {
      questions: [
        { prompt: { media: { hash: h("a") } }, answerSpec: { kind: "single", options: [{ id: "x", media: { hash: h("b") } }, { id: "y" }] } },
        { prompt: { media: { hash: h("a") } }, answerSpec: { kind: "boolean" } },
      ],
    };
    expect(gameMediaHashes(game).toSorted()).toEqual([h("a"), h("b")]);
  });

  it("also collects studio graphics: scene styles / states / props (url(/media/<hash>)) and theme logo / sounds", () => {
    const zones = [
      { ...zone("x"), id: "a", props: { src: `/media/${h("c")}` }, style: { "border-image": `url(/media/${h("d")}) 10 fill / 10px stretch` }, states: { correct: { "background-image": `url(/media/${h("e")})` } } },
      zone("no media here, /media/short"),
    ];
    const game = {
      questions: [],
      scenes: [Scene.parse({ id: "s", name: "s", layers: [{ id: "l", name: "l", z: 0, mode: "auto", phases: [], zones }] })],
      theme: Theme.parse({ ...DEFAULT_THEME, logo: h("f"), sounds: { "answer.correct": h("1"), podium: h("2") } }),
    };
    expect(gameMediaHashes(game).toSorted()).toEqual([h("1"), h("2"), h("c"), h("d"), h("e"), h("f")]);
  });

  it("no false positive on 65 hex chars or upper case, no false negative before a non-hex char", () => {
    const scenes = [{ id: "s", name: "s", size: { w: 1920, h: 1080 }, layers: [{ id: "l", name: "l", z: 0, mode: "auto" as const, phases: [], zones: [zone(`/media/${h("a")}a`), zone(`/media/${"A".repeat(64)}`), zone(`/media/${h("b")}_x`)] }] }];
    expect(lookMediaHashes({ scenes })).toEqual([h("b")]);
  });
});

describe("preloadFor (review I1 / I2)", () => {
  const game = { ...DEMO_GAME, questions: [{ ...DEMO_GAME.questions[0]!, prompt: { text: "Q", media: { hash: h("a"), mime: "image/png" } } }], theme: Theme.parse({ ...DEFAULT_THEME, logo: h("b"), sounds: { podium: h("c") } }) }; // oxlint-disable-line typescript/no-non-null-assertion -- fixture has questions
  const present = { pathOf: (x: string) => (x === h("c") ? null : `/x/${x}`) };
  it("tablets get question media only; outputs also get the look; missing hashes are dropped", () => {
    expect(preloadFor({ role: "player" }, game, present)).toEqual([h("a")]);
    expect(preloadFor({ role: "seat" }, game, present)).toEqual([h("a")]);
    expect(preloadFor({ role: "output" }, game, present).toSorted()).toEqual([h("a"), h("b")]); // h("c") absent on disk
    // Allow-list: roles that do not render the look get questions only.
    expect(preloadFor({ role: "scorer" }, game, present)).toEqual([h("a")]);
    expect(preloadFor({ role: "control-readonly" }, game, present)).toEqual([h("a")]);
  });

  it("PreloadCache touches the disk once per game / media generation, not once per connection (review R1)", () => {
    let calls = 0;
    const store = { generation: 0, pathOf: (x: string) => { calls++; return x === h("c") ? null : `/x/${x}`; } };
    const cache = new PreloadCache(store);
    for (let i = 0; i < 500; i++) cache.for({ role: "player" }, game);
    for (let i = 0; i < 10; i++) cache.for({ role: "output" }, game);
    expect(calls).toBe(1 + 3);
    store.generation++; // a media was stored: the next welcome recomputes
    expect(cache.for({ role: "output" }, game).toSorted()).toEqual([h("a"), h("b")]);
    expect(calls).toBe(1 + 3 + 3);
  });
});
