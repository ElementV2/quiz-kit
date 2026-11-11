import { spawnSync } from "node:child_process";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { MediaStore, gameMediaHashes } from "./media-store.ts";

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
});
