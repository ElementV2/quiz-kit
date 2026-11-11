import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_THEME, DEMO_GAME, PROGRAM_SCENE, Theme, type GameDocument } from "@quiz/schema";
import { GameLibrary, exportQuiz, importQuiz } from "./library.ts";
import { MediaStore } from "./media-store.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "quiz-lib-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// 1×1 transparent PNG (valid file, no ffmpeg needed for a PNG put: browser format, probe optional).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("GameLibrary", () => {
  it("saves, lists, loads and deletes validated games", () => {
    const lib = new GameLibrary(tmp());
    expect(lib.put("g_demo", DEMO_GAME)).toMatchObject({ ok: true });
    expect(lib.list()).toMatchObject([{ id: "g_demo", title: "Démo culture G", questions: 3 }]);
    expect(lib.get("g_demo")?.title).toBe("Démo culture G");
    expect(lib.put("g_bad", { title: "x" })).toMatchObject({ ok: false });
    expect(lib.put("../evil", DEMO_GAME)).toMatchObject({ ok: false });
    expect(lib.delete("g_demo")).toBe(true);
    expect(lib.list()).toEqual([]);
  });
});

describe(".quiz archive", () => {
  it("round-trips a game and its media to another machine", async () => {
    const source = new MediaStore(tmp());
    const meta = await source.put(Readable.from([PNG]), "image/png", "pixel.png");
    const first = DEMO_GAME.questions[0];
    if (first === undefined) throw new Error("fixture");
    const game: GameDocument = { ...DEMO_GAME, questions: [{ ...first, prompt: { text: first.prompt.text, media: source.asMedia(meta) } }, ...DEMO_GAME.questions.slice(1)] };
    const zip = exportQuiz(game, source);
    expect(Object.keys(unzipSync(zip)).toSorted()).toEqual(["game.json", `media/${meta.hash}`, `media/${meta.hash}.json`]);

    const target = new MediaStore(tmp());
    const r = await importQuiz(zip, target);
    expect(r).toMatchObject({ ok: true, media: 1 });
    expect(target.pathOf(meta.hash)).not.toBeNull();
  });

  it("carries studio graphics too: scene asset and theme logo survive the round trip (the bug behind gameMediaHashes)", async () => {
    const source = new MediaStore(tmp());
    const asset = await source.put(Readable.from([PNG]), "image/png", "answers_idle@2x.png");
    const logo = await source.put(Readable.from([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')]), "image/svg+xml", "logo.svg");
    const scene = structuredClone(PROGRAM_SCENE);
    const z = scene.layers[0]?.zones[0];
    if (z === undefined) throw new Error("fixture");
    z.states.idle = { "background-image": `url(/media/${asset.hash})` };
    const game: GameDocument = { ...DEMO_GAME, scenes: [scene], theme: Theme.parse({ ...DEFAULT_THEME, logo: logo.hash }) };
    const target = new MediaStore(tmp());
    const r = await importQuiz(exportQuiz(game, source), target);
    expect(r).toMatchObject({ ok: true, media: 2, missing: 0 });
    expect(target.pathOf(asset.hash)).not.toBeNull();
    expect(target.pathOf(logo.hash)).not.toBeNull();
  });

  it("reports media referenced by the game but absent from the archive", async () => {
    const game: GameDocument = { ...DEMO_GAME, theme: Theme.parse({ ...DEFAULT_THEME, logo: "9".repeat(64) }) };
    const r = await importQuiz(exportQuiz(game, new MediaStore(tmp())), new MediaStore(tmp()));
    expect(r).toMatchObject({ ok: true, media: 0, missing: 1 });
  });

  it("refuses an archive whose media bytes do not match their hash", async () => {
    const h = "0".repeat(64);
    const first = DEMO_GAME.questions[0];
    if (first === undefined) throw new Error("fixture");
    const game = { ...DEMO_GAME, questions: [{ ...first, prompt: { text: "x", media: { hash: h, mime: "image/png" } } }, ...DEMO_GAME.questions.slice(1)] };
    const zip = zipSync({ "game.json": strToU8(JSON.stringify(game)), [`media/${h}`]: new Uint8Array(PNG), [`media/${h}.json`]: strToU8('{"mime":"image/png"}') });
    expect(await importQuiz(zip, new MediaStore(tmp()))).toMatchObject({ ok: false, error: expect.stringMatching(/corrompu/) });
  });

  it("refuses garbage", async () => {
    expect(await importQuiz(new Uint8Array([1, 2, 3]), new MediaStore(tmp()))).toMatchObject({ ok: false });
  });
});
