import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { Readable } from "node:stream";
import { z } from "zod";
import { MediaHash, type Media } from "@quiz/schema";

/**
 * Content-addressed media store (doc 07, ADR-A7): `media/<sha256>` + `<sha256>.json` metadata.
 * Same bytes = same hash = stored once; a hash in a game document can never point at other bytes.
 * Imported files are probed (ffprobe) and normalised (ffmpeg) when browsers could not play them.
 */

export const MediaMeta = z.strictObject({
  hash: MediaHash,
  mime: z.string(),
  size: z.number().int().nonnegative(),
  name: z.string().max(200),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Set when the file was converted at import (original hash kept for traceability). */
  convertedFrom: MediaHash.optional(),
});
export type MediaMeta = z.infer<typeof MediaMeta>;

const BROWSER_MIME = /^(image\/(png|jpeg|webp|gif|svg\+xml|avif)|video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|wav|webm|aac|x-wav))$/;
const MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB

export type Tools = { ffmpeg: string; ffprobe: string };

function run(cmd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString().slice(-4000)));
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const Probe = z.object({
  streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string().optional(), width: z.number().optional(), height: z.number().optional(), sample_rate: z.string().optional(), pix_fmt: z.string().optional() })).default([]),
  format: z.object({ duration: z.string().optional(), format_name: z.string().optional() }).optional(),
});
type ProbeResult = z.infer<typeof Probe>;

export class MediaStore {
  readonly dir: string;
  private readonly tools: Tools;

  constructor(dataDir: string, tools: Tools = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }) {
    this.dir = join(dataDir, "media");
    mkdirSync(this.dir, { recursive: true });
    this.tools = tools;
  }

  pathOf(hash: string): string | null {
    if (!MediaHash.safeParse(hash).success) return null;
    const p = join(this.dir, hash);
    return existsSync(p) ? p : null;
  }

  meta(hash: string): MediaMeta | null {
    if (!MediaHash.safeParse(hash).success) return null;
    const p = join(this.dir, `${hash}.json`);
    if (!existsSync(p)) return null;
    const r = MediaMeta.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return r.success ? r.data : null;
  }

  /** As referenced from a game document (`Media` schema). */
  asMedia(m: MediaMeta): Media {
    return { hash: m.hash, mime: m.mime, ...(m.w === undefined ? {} : { w: m.w }), ...(m.h === undefined ? {} : { h: m.h }), ...(m.durationMs === undefined ? {} : { durationMs: m.durationMs }) };
  }

  /** Streams an upload to disk while hashing it, probes it, converts it if needed. */
  async put(body: Readable, mime: string, name: string): Promise<MediaMeta> {
    const tmp = join(this.dir, `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const hasher = createHash("sha256");
    let size = 0;
    body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) body.destroy(new Error("fichier trop gros (1 Gio max)"));
      hasher.update(chunk);
    });
    try {
      await pipeline(body, createWriteStream(tmp));
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    const hash = hasher.digest("hex");
    const existing = this.meta(hash);
    if (existing !== null) {
      rmSync(tmp, { force: true });
      return existing;
    }
    const probe = await this.probe(tmp);
    const converted = await this.normalise(tmp, mime, probe);
    if (converted !== null) {
      // Store the converted file under ITS hash; the original is dropped (browsers could not play it).
      const meta = await this.adopt(converted.path, converted.mime, name, hash);
      rmSync(tmp, { force: true });
      return meta;
    }
    renameSync(tmp, join(this.dir, hash));
    return this.writeMeta({ hash, mime, size, name: name.slice(0, 200), ...dims(probe) });
  }

  private async adopt(path: string, mime: string, name: string, from: string): Promise<MediaMeta> {
    const hasher = createHash("sha256");
    await pipeline(createReadStream(path), hasher);
    const hash = hasher.digest("hex");
    const target = join(this.dir, hash);
    if (existsSync(target)) rmSync(path, { force: true });
    else renameSync(path, target);
    const probe = await this.probe(target);
    return this.writeMeta({ hash, mime, size: statSync(target).size, name: name.slice(0, 200), convertedFrom: from, ...dims(probe) });
  }

  private writeMeta(m: MediaMeta): MediaMeta {
    writeFileSync(join(this.dir, `${m.hash}.json`), JSON.stringify(m));
    return m;
  }

  private async probe(path: string): Promise<ProbeResult | null> {
    const r = await run(this.tools.ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path]);
    if (r.code !== 0) return null;
    const p = Probe.safeParse(JSON.parse(r.stdout || "{}"));
    return p.success ? p.data : null;
  }

  /**
   * Converts what browsers (and CEF in OBS / vMix) cannot play (doc 07 « transcodé par l'app ») :
   * - video not mp4/webm (e.g. ProRes 4444 stinger) → WebM VP9, alpha kept when present;
   * - audio not at 48 kHz → WAV 48 kHz (doc 07 « sons WAV 48 kHz »).
   */
  private async normalise(path: string, mime: string, probe: ProbeResult | null): Promise<{ path: string; mime: string } | null> {
    const video = probe?.streams.find((s) => s.codec_type === "video");
    const audio = probe?.streams.find((s) => s.codec_type === "audio");
    const out = `${path}.out`;
    if (mime.startsWith("video/") && !BROWSER_MIME.test(mime)) {
      const alpha = video?.pix_fmt?.includes("a") === true; // yuva*, argb… (ProRes 4444 has alpha)
      const r = await run(this.tools.ffmpeg, ["-y", "-v", "error", "-i", path, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-pix_fmt", alpha ? "yuva420p" : "yuv420p", "-c:a", "libopus", "-f", "webm", out]);
      if (r.code !== 0) throw new Error(`conversion vidéo impossible : ${r.stderr.slice(-300)}`);
      return { path: out, mime: "video/webm" };
    }
    if (mime.startsWith("audio/") && audio?.sample_rate !== undefined && audio.sample_rate !== "48000") {
      const r = await run(this.tools.ffmpeg, ["-y", "-v", "error", "-i", path, "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav", out]);
      if (r.code !== 0) throw new Error(`conversion audio impossible : ${r.stderr.slice(-300)}`);
      return { path: out, mime: "audio/wav" };
    }
    if (!BROWSER_MIME.test(mime)) throw new Error(`format non pris en charge : ${mime}`);
    return null;
  }
}

function dims(p: ProbeResult | null): Pick<MediaMeta, "w" | "h" | "durationMs"> {
  const v = p?.streams.find((s) => s.codec_type === "video");
  const d = Number(p?.format?.duration ?? Number.NaN);
  return {
    ...(v?.width !== undefined && v.width > 0 ? { w: v.width } : {}),
    ...(v?.height !== undefined && v.height > 0 ? { h: v.height } : {}),
    ...(Number.isFinite(d) && d > 0 && v?.codec_name !== "png" && v?.codec_name !== "mjpeg" ? { durationMs: Math.round(d * 1000) } : {}),
  };
}

/** Every media hash a game references (preload list, doc 04 `preload`). */
export function gameMediaHashes(game: { questions: readonly { prompt: { media?: { hash: string } | undefined }; answerSpec: unknown }[] }): string[] {
  const out = new Set<string>();
  for (const q of game.questions) {
    if (q.prompt.media !== undefined) out.add(q.prompt.media.hash);
    const spec = q.answerSpec;
    if (typeof spec === "object" && spec !== null && "options" in spec && Array.isArray(spec.options)) {
      for (const o of spec.options as unknown[]) { // oxlint-disable-line typescript/no-unsafe-type-assertion -- walked defensively below
        if (typeof o === "object" && o !== null && "media" in o && typeof o.media === "object" && o.media !== null && "hash" in o.media && typeof o.media.hash === "string") out.add(o.media.hash);
      }
    }
  }
  return [...out];
}
