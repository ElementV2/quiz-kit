import type Sharp from "sharp";
import type { View } from "@quiz/schema";
import type { MediaStore } from "./media-store.ts";

/**
 * « Image dévoilée » on the tablets (doc 10, ADR-0017): a tablet never gets the picture itself (its hash would open
 * the whole image at `/media/<hash>`). It asks for each tile by question id and index; the server checks the live
 * state, cuts out only an uncovered tile, and answers 404 for any other one.
 *
 * Cost at the reveal (every tile, every tablet at once): each picture is decoded once, turned upright (EXIF) and
 * reduced to `MAX_SIDE`, kept raw in memory; each tile is cut from it once (small WebP) and kept. A picture that cannot
 * be read is remembered as such (no decode per request). `sharp` (native libvips) is loaded on the first tile only:
 * if it cannot load on this machine, the show runs on and only the tablets' tiles are missing.
 */

export type TileOf = { readonly hash: string; readonly cols: number; readonly rows: number; readonly index: number };

/** The tile to serve, or null when it is not uncovered on the question on air (read from the control room's view). */
export function uncoveredTile(view: View, questionId: string, index: number): TileOf | null {
  const m = view.mechanic;
  if (m?.mechanic !== "reveal-image" || m.image === null || view.question?.id !== questionId) return null;
  if (!Number.isInteger(index) || index < 0 || index >= m.cols * m.rows || !m.revealed.includes(index)) return null;
  return { hash: m.image.hash, cols: m.cols, rows: m.rows, index };
}

/** Pixel box of tile `index` (row-major) in a w × h picture: tiles share the remainder, they cover it exactly. */
export function tileBox(w: number, h: number, cols: number, rows: number, index: number): { left: number; top: number; width: number; height: number } {
  const col = index % cols;
  const row = Math.floor(index / cols);
  const left = Math.floor((col * w) / cols);
  const top = Math.floor((row * h) / rows);
  return { left, top, width: Math.floor(((col + 1) * w) / cols) - left, height: Math.floor(((row + 1) * h) / rows) - top };
}

/** Long side of the picture the tiles are cut from: sharp enough on a tablet, light on the players' Wi-Fi. */
export const MAX_SIDE = 1600;
const MAX_PICTURES = 3;
const MAX_TILES = 400;

type Upright = { readonly data: Buffer; readonly width: number; readonly height: number; readonly channels: 1 | 2 | 3 | 4 };
type SharpFn = typeof Sharp;

/** Insertion-ordered cache: the oldest entry goes first. */
class Memo<T> {
  private readonly map = new Map<string, Promise<T>>();
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(key: string, make: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit !== undefined) return hit;
    const made = make();
    this.map.set(key, made);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return made;
  }
}

export class TileCutter {
  private readonly media: MediaStore;
  private readonly warn: (message: string) => void;
  private readonly load: () => Promise<SharpFn>;
  private sharp: Promise<SharpFn | null> | null = null;
  private readonly pictures = new Memo<Upright | null>(MAX_PICTURES);
  private readonly tiles = new Memo<Buffer | null>(MAX_TILES);

  constructor(media: MediaStore, warn: (message: string) => void = () => {}, load: () => Promise<SharpFn> = async () => (await import("sharp")).default) {
    this.media = media;
    this.warn = warn;
    this.load = load;
  }

  /** WebP bytes of the tile, null when the picture is missing or unreadable (remembered: no retry per request). */
  cut(t: TileOf): Promise<Buffer | null> {
    // A picture not on disk yet (standby still copying it) is not remembered: it is retried once it arrives.
    if (this.media.pathOf(t.hash) === null) return Promise.resolve(null);
    return this.tiles.get(`${t.hash}/${t.cols}x${t.rows}/${t.index}`, async () => {
      const sharp = await this.lib();
      if (sharp === null) return null;
      const pic = await this.picture(sharp, t.hash);
      if (pic === null) return null;
      try {
        const raw = { width: pic.width, height: pic.height, channels: pic.channels };
        return await sharp(pic.data, { raw }).extract(tileBox(pic.width, pic.height, t.cols, t.rows, t.index)).webp({ quality: 82 }).toBuffer();
      } catch (e) {
        this.warn(`case ${t.index} de ${t.hash} : ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    });
  }

  private lib(): Promise<SharpFn | null> {
    this.sharp ??= this.load().catch((e: unknown) => {
      this.warn(`sharp ne se charge pas : les cases « Image dévoilée » ne s'affichent pas sur les tablettes (${e instanceof Error ? e.message : String(e)})`);
      return null;
    });
    return this.sharp;
  }

  /** The picture decoded once, upright, at most MAX_SIDE, raw. Null (remembered): missing or unreadable. */
  private picture(sharp: SharpFn, hash: string): Promise<Upright | null> {
    return this.pictures.get(hash, async () => {
      const path = this.media.pathOf(hash);
      if (path === null) return null; // checked by `cut` just before
      try {
        const { data, info } = await sharp(path).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height, channels: info.channels };
      } catch (e) {
        this.warn(`image ${hash} illisible pour les cases : ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    });
  }
}
