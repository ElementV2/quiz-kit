import { join } from "node:path";
import type { SessionRuntime, Timers } from "../runtime/session-runtime.ts";
import { ChatIngest } from "./ingest.ts";
import { TwitchChat, type Fetch, type TwitchStatus } from "./twitch.ts";
import { YouTubeChat, type YouTubeStatus } from "./youtube.ts";

type Log = { info(o: object, msg: string): void; warn(o: object, msg: string): void };

/** Chat connectors of the show (the only internet dependency allowed during a show, CLAUDE.md n° 7). */
export class ChatHub {
  readonly ingest: ChatIngest;
  readonly twitch: TwitchChat | null;
  readonly youtube: YouTubeChat | null;

  constructor(opts: { runtime: () => SessionRuntime; timers: Timers; clock: () => number; dataDir: string; twitchClientId?: string | undefined; youtubeApiKey?: string | undefined; log: Log; fetch?: Fetch }) {
    this.ingest = new ChatIngest({ runtime: opts.runtime, timers: opts.timers, clock: opts.clock });
    const onMessage = this.ingest.push.bind(this.ingest);
    this.twitch = opts.twitchClientId === undefined ? null : new TwitchChat({ clientId: opts.twitchClientId, tokenPath: join(opts.dataDir, "twitch-token.json"), onMessage, log: opts.log, ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }) });
    this.youtube = opts.youtubeApiKey === undefined ? null : new YouTubeChat({ apiKey: opts.youtubeApiKey, onMessage, ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }) });
  }

  status(): { twitch: (TwitchStatus & { authorised: boolean }) | null; youtube: YouTubeStatus | null; ingest: ChatIngest["stats"] } {
    return {
      twitch: this.twitch === null ? null : { ...this.twitch.status, authorised: this.twitch.hasToken },
      youtube: this.youtube === null ? null : { ...this.youtube.status },
      ingest: { ...this.ingest.stats },
    };
  }

  close(): void {
    this.twitch?.stop();
    this.youtube?.stop();
    this.ingest.close();
  }
}
