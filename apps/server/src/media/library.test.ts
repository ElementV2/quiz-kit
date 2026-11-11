import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { DEMO_GAME, type GameDocument } from "@quiz/schema";
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
