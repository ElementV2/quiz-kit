import type { GameDocument } from "@quiz/schema";
import { lookMediaHashes, questionMediaHashes, type MediaStore } from "./media-store.ts";

/** Audiences that render the look (scene graphics, logo, sound pack). Allow-list: a new role gets questions only. */
const LOOK_ROLES: ReadonlySet<string> = new Set(["output", "host", "control", "studio"]);

/**
 * Preload list per audience (review I1): tablets and other roles get question media only; outputs, host, control and
 * studio also get the look. Hashes missing on this server are dropped (review I2: no 404 storm on reconnect).
 */
export function preloadFor(viewer: { readonly role: string }, game: GameDocument, media: Pick<MediaStore, "pathOf">): string[] {
  const hashes = LOOK_ROLES.has(viewer.role) ? [...new Set([...questionMediaHashes(game), ...lookMediaHashes(game)])] : questionMediaHashes(game);
  return hashes.filter((h) => media.pathOf(h) !== null);
}

/**
 * Same lists, computed once per (game, media generation) — review R1: a welcome must never hit the disk, a wave of
 * 500 reconnections would otherwise run thousands of blocking `existsSync` on the game loop.
 */
export class PreloadCache {
  private game: GameDocument | null = null;
  private generation = -1;
  private readonly lists = new Map<boolean, string[]>();
  private readonly media: Pick<MediaStore, "pathOf" | "generation">;

  constructor(media: Pick<MediaStore, "pathOf" | "generation">) {
    this.media = media;
  }

  for(viewer: { readonly role: string }, game: GameDocument): string[] {
    if (game !== this.game || this.media.generation !== this.generation) {
      this.game = game;
      this.generation = this.media.generation;
      this.lists.clear();
    }
    const look = LOOK_ROLES.has(viewer.role);
    let l = this.lists.get(look);
    if (l === undefined) {
      l = preloadFor(viewer, game, this.media);
      this.lists.set(look, l);
    }
    return l;
  }
}
