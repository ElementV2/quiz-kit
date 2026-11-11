import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { loadGameDocument, type GameDocument } from "@quiz/schema";
import { gameMediaHashes, type MediaStore } from "./media-store.ts";

const GAME_ID = /^g_[0-9A-Za-z_-]{1,64}$/;

export type GameSummary = { readonly id: string; readonly title: string; readonly questions: number; readonly rounds: number; readonly updatedAt: number };

/** Studio game library (doc 07): one validated JSON file per game in `<data>/games/`. */
export class GameLibrary {
  private readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "games");
    mkdirSync(this.dir, { recursive: true });
  }

  static isId(id: string): boolean {
    return GAME_ID.test(id);
  }

  list(): GameSummary[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        const id = f.slice(0, -5);
        const g = this.get(id);
        return g === null ? [] : [{ id, title: g.title, questions: g.questions.length, rounds: g.format.rounds.length, updatedAt: statSync(join(this.dir, f)).mtimeMs }];
      })
      .toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): GameDocument | null {
    if (!GameLibrary.isId(id)) return null;
    const p = join(this.dir, `${id}.json`);
    if (!existsSync(p)) return null;
    const r = loadGameDocument(JSON.parse(readFileSync(p, "utf8")));
    return r.ok ? r.value : null;
  }

  /** Validates (migrations included) then writes atomically. */
  put(id: string, raw: unknown): { ok: true; game: GameDocument } | { ok: false; error: unknown } {
    if (!GameLibrary.isId(id)) return { ok: false, error: "identifiant invalide" };
    const r = loadGameDocument(raw);
    if (!r.ok) return { ok: false, error: r.error };
    const tmp = join(this.dir, `${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(r.value, null, 2));
    renameSync(tmp, join(this.dir, `${id}.json`));
    return { ok: true, game: r.value };
  }

  delete(id: string): boolean {
    if (!GameLibrary.isId(id)) return false;
    const p = join(this.dir, `${id}.json`);
    if (!existsSync(p)) return false;
    rmSync(p);
    return true;
  }
}

/**
 * `.quiz` archive (doc 01): zip with `game.json` + `media/<sha256>` (+ `.json` metadata).
 * Media are addressed by hash, so importing the same archive twice stores nothing twice.
 */
export function exportQuiz(game: GameDocument, media: MediaStore): Uint8Array {
  const files: Zippable = { "game.json": strToU8(JSON.stringify(game, null, 2)) };
  for (const hash of gameMediaHashes(game)) {
    const p = media.pathOf(hash);
    const m = media.meta(hash);
    if (p === null || m === null) continue;
    files[`media/${hash}`] = [new Uint8Array(readFileSync(p)), { level: 0 }]; // already compressed formats
    files[`media/${hash}.json`] = strToU8(JSON.stringify(m));
  }
  return zipSync(files, { level: 6 });
}

export async function importQuiz(zip: Uint8Array, media: MediaStore): Promise<{ ok: true; game: GameDocument; media: number; missing: number } | { ok: false; error: string }> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    return { ok: false, error: "archive .quiz illisible" };
  }
  const gameFile = files["game.json"];
  if (gameFile === undefined) return { ok: false, error: "game.json absent de l'archive" };
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(gameFile));
  } catch {
    return { ok: false, error: "game.json illisible" };
  }
  const r = loadGameDocument(raw);
  if (!r.ok) return { ok: false, error: `jeu invalide : ${JSON.stringify(r.error)}` };
  let count = 0;
  const missing: string[] = [];
  for (const hash of gameMediaHashes(r.value)) {
    const bytes = files[`media/${hash}`];
    const metaRaw = files[`media/${hash}.json`];
    if (bytes === undefined || metaRaw === undefined) {
      if (media.pathOf(hash) === null) missing.push(hash);
      continue;
    }
    // Never trust the archive's file names: the bytes must hash to the name.
    if (createHash("sha256").update(bytes).digest("hex") !== hash) return { ok: false, error: `média corrompu : ${hash.slice(0, 12)}…` };
    let meta: unknown = null;
    try {
      meta = JSON.parse(strFromU8(metaRaw));
    } catch {
      // name / type unknown: defaults below
    }
    const mime = typeof meta === "object" && meta !== null && "mime" in meta && typeof meta.mime === "string" ? meta.mime : null;
    if (mime === null) {
      missing.push(hash); // unreadable meta: this media is skipped, the rest of the game still imports (review R3)
      continue;
    }
    const name = typeof meta === "object" && meta !== null && "name" in meta && typeof meta.name === "string" ? meta.name : hash;
    try {
      await media.put(Readable.from([Buffer.from(bytes)]), mime, name);
      count++;
    } catch (err) {
      return { ok: false, error: `média refusé (${name}) : ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: true, game: r.value, media: count, missing: missing.length };
}
