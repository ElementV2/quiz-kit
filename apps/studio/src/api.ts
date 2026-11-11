import { tokenFromUrl } from "@quiz/ui";
import type { GameDocument, Media } from "@quiz/schema";

const token = tokenFromUrl();
const withToken = (path: string): string => `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;

async function json<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own server endpoints; documents are re-validated with Zod where used
}

export type GameSummary = { id: string; title: string; questions: number; rounds: number; updatedAt: number };

export const api = {
  list: async (): Promise<GameSummary[]> => (await json<{ games: GameSummary[] }>(await fetch(withToken("/api/games")))).games,
  get: async (id: string): Promise<unknown> => (await json<{ game: unknown }>(await fetch(withToken(`/api/games/${id}`)))).game,
  save: async (id: string, game: GameDocument): Promise<void> => {
    await json(await fetch(withToken(`/api/games/${id}`), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ game }) }));
  },
  remove: async (id: string): Promise<void> => {
    await json(await fetch(withToken(`/api/games/${id}`), { method: "DELETE" }));
  },
  exportUrl: (id: string): string => withToken(`/api/games/${id}/export`),
  importQuiz: async (file: File): Promise<{ id: string; title: string; media: number; missing: number }> =>
    json(await fetch(withToken("/api/import"), { method: "POST", headers: { "content-type": "application/zip" }, body: file })),
  /**
   * Whole journal of the current session (replay, doc 09). The server pages it (≤ 2000 events per call):
   * loop on `next` until null. Raw JSON: validated with Zod by the caller.
   */
  journal: async (onProgress?: (loaded: number, lastSeq: number) => void): Promise<{ session: unknown; events: unknown[] }> => {
    type Page = { session: unknown; events: unknown[]; lastSeq?: number; next?: number | null };
    let from: number | null = 1;
    let session: unknown = null;
    const events: unknown[] = [];
    while (from !== null) {
      const page: Page = await json<Page>(await fetch(withToken(`/api/journal?from=${from}`)));
      session = page.session;
      events.push(...page.events);
      onProgress?.(events.length, page.lastSeq ?? events.length);
      const next: number | null = page.next ?? null;
      from = next !== null && next > from ? next : null; // never loop on a server that does not page
    }
    return { session, events };
  },
  upload: async (file: File): Promise<Media> => {
    const res = await fetch(withToken(`/api/media?name=${encodeURIComponent(file.name)}`), { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
    return (await json<{ media: Media }>(res)).media;
  },
};

export const mediaUrl = (hash: string): string => `/media/${hash}`;

/** Downloads a text / blob as a file (template export). */
export function download(name: string, content: string | Blob, type = "text/plain"): void {
  const blob = typeof content === "string" ? new Blob([content], { type }) : content;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** SVG → PNG at 1x through a canvas (browser-side rasterisation, no server dependency). */
export async function svgToPng(svg: string, w: number, h: number): Promise<Blob> {
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(img.src);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b === null ? reject(new Error("PNG impossible")) : resolve(b)), "image/png"));
}

/** Pixel size of an image file (re-import size check). */
export async function imageSize(file: File): Promise<{ w: number; h: number }> {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  const r = { w: img.naturalWidth, h: img.naturalHeight };
  URL.revokeObjectURL(img.src);
  return r;
}
