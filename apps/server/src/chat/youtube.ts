import { z } from "zod";
import type { ChatMessage } from "./ingest.ts";
import type { Fetch } from "./twitch.ts";

/**
 * YouTube Live chat by polling (verified on developers.google.com, see docs/api/chat.md):
 * `videos.list?part=liveStreamingDetails&id=<videoId>` (1 unit) → `liveStreamingDetails.activeLiveChatId`, then
 * `liveChat/messages?liveChatId=…&part=snippet,authorDetails&pageToken=…` (5 units per call) every
 * `pollingIntervalMillis` (imposed by YouTube). Only `textMessageEvent` items are read
 * (`snippet.textMessageDetails.messageText`, `authorDetails.channelId`). The first page is the recent backlog:
 * skipped (votes from before the start must not count). Default quota 10 000 units/day ≈ 2 h 45 of polling.
 * NOT VERIFIED (docs/OPEN-QUESTIONS.md): whether an API key is enough for `list` (no OAuth implemented).
 */

const API = "https://www.googleapis.com/youtube/v3";

const Messages = z.object({
  nextPageToken: z.string().optional(),
  pollingIntervalMillis: z.number().optional(),
  offlineAt: z.string().optional(),
  items: z.array(
    z.object({
      snippet: z.object({ type: z.string(), textMessageDetails: z.object({ messageText: z.string() }).optional() }),
      authorDetails: z.object({ channelId: z.string() }),
    }),
  ).default([]),
});

export type YouTubeStatus = { state: "off" | "connecting" | "live" | "ended" | "error"; videoId: string | null; error: string | null; messages: number; calls: number };

export class YouTubeChat {
  readonly status: YouTubeStatus = { state: "off", videoId: null, error: null, messages: 0, calls: 0 };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private readonly opts: { apiKey: string; onMessage: (m: ChatMessage) => void; fetch?: Fetch; minIntervalMs?: number };

  constructor(opts: { apiKey: string; onMessage: (m: ChatMessage) => void; fetch?: Fetch; minIntervalMs?: number }) {
    this.opts = opts;
  }

  /** Every request gives up after 10 s (a hanging network must never freeze the polling loop). */
  private fetch(url: string): Promise<Response> {
    return (this.opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
  }

  async start(videoId: string): Promise<void> {
    this.stop();
    const gen = ++this.generation;
    this.status.videoId = videoId;
    this.status.state = "connecting";
    this.status.error = null;
    const res = await this.fetch(`${API}/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(this.opts.apiKey)}`);
    this.status.calls++;
    const body = z.object({ items: z.array(z.object({ liveStreamingDetails: z.object({ activeLiveChatId: z.string().optional() }).optional() })).default([]) }).safeParse(await res.json().catch(() => null));
    const chatId = body.success ? body.data.items[0]?.liveStreamingDetails?.activeLiveChatId : undefined;
    if (!res.ok || chatId === undefined) {
      this.status.state = "error";
      this.status.error = res.ok ? "pas de chat en direct sur cette vidéo (live terminé ou pas commencé ?)" : `YouTube a refusé (${res.status})`;
      return;
    }
    await this.poll(gen, chatId, undefined, true);
  }

  private async poll(gen: number, chatId: string, pageToken: string | undefined, first: boolean): Promise<void> {
    if (gen !== this.generation) return;
    const url = `${API}/liveChat/messages?liveChatId=${encodeURIComponent(chatId)}&part=snippet,authorDetails&key=${encodeURIComponent(this.opts.apiKey)}${pageToken === undefined ? "" : `&pageToken=${encodeURIComponent(pageToken)}`}`;
    const res = await this.fetch(url).catch(() => null);
    this.status.calls++;
    if (gen !== this.generation) return;
    const parsed = res === null ? null : Messages.safeParse(await res.json().catch(() => null));
    if (res === null || !res.ok || parsed === null || !parsed.success) {
      this.status.state = "error";
      this.status.error = res === null ? "YouTube injoignable (réseau)" : `YouTube a refusé (${res.status})`;
      this.timer = setTimeout(() => void this.poll(gen, chatId, pageToken, first), 10_000); // retry, keep the page
      return;
    }
    const d = parsed.data;
    this.status.state = "live";
    this.status.error = null;
    if (!first) {
      for (const it of d.items) {
        if (it.snippet.type !== "textMessageEvent" || it.snippet.textMessageDetails === undefined) continue;
        this.status.messages++;
        this.opts.onMessage({ platform: "yt", userId: it.authorDetails.channelId, text: it.snippet.textMessageDetails.messageText });
      }
    }
    if (d.offlineAt !== undefined) {
      this.status.state = "ended";
      return;
    }
    const wait = Math.max(this.opts.minIntervalMs ?? 2000, d.pollingIntervalMillis ?? 5000);
    this.timer = setTimeout(() => void this.poll(gen, chatId, d.nextPageToken ?? pageToken, false), wait);
  }

  stop(): void {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.status.state !== "error") this.status.state = "off";
  }
}
