import { Readable } from "node:stream";
import { z } from "zod";
import { Event, Session } from "@quiz/schema";
import { gameMediaHashes, type MediaStore } from "./media/media-store.ts";
import type { SessionRuntime } from "./runtime/session-runtime.ts";

/**
 * Hot standby (doc 05 « bascule »): a second show server follows the primary's journal
 * (`GET <primary>/api/journal?from=<seq>`, paged, control token of the primary) every `intervalMs`, writes every
 * event into its own journal and folds it — so the standby holds the exact same state, a few hundred ms behind.
 * It also copies the game's media it lacks (`/media/<hash>` is public). Until promoted, it refuses every intent and
 * arms no timer. Promotion is MANUAL (control room of the standby): an automatic one could leave two servers
 * deciding at the same time (split brain) when only the network between them failed.
 * Both servers must share `secret.key` so that every link and token works on either.
 */

const Page = z.object({ session: Session, events: z.array(Event), lastSeq: z.number().int(), next: z.number().int().nullable(), build: z.string() });

export type StandbyStatus = {
  mode: "standby" | "promoted";
  primary: string;
  sessionId: string | null;
  /** Primary's last seq minus ours (0 = in sync). */
  lag: number;
  lastContactAt: number | null;
  error: string | null;
  mediaCopied: number;
  /** Media of the game still missing here (the takeover would show holes). */
  mediaMissing: number;
  /** Set when the mirror stopped following because both journals no longer match: promotion is unsafe. */
  diverged: string | null;
};

export class StandbyMirror {
  readonly status: StandbyStatus;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly opts: {
    primary: string;
    token: string;
    intervalMs: number;
    runtime: () => SessionRuntime;
    openSession: (s: Session) => void;
    hasSession: (id: string) => boolean;
    createSession: (s: Session) => void;
    media: MediaStore;
    clock: () => number;
    fetch: typeof fetch;
    /** This server's build id (see `buildId`): must equal the primary's. */
    build: string;
  };

  constructor(opts: StandbyMirror["opts"]) {
    this.opts = opts;
    this.status = { mode: "standby", primary: opts.primary, sessionId: null, lag: 0, lastContactAt: null, error: null, mediaCopied: 0, mediaMissing: 0, diverged: null };
  }

  start(): void {
    this.stopped = false;
    this.opts.runtime().setStandby(true);
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async get(url: string): Promise<Response> {
    return this.opts.fetch(url, { headers: { authorization: `Bearer ${this.opts.token}` }, signal: AbortSignal.timeout(5000) });
  }

  private async tick(): Promise<void> {
    try {
      await this.follow();
    } catch (err) {
      this.status.error = err instanceof Error ? err.message : String(err);
    }
    if (this.stopped) return;
    void this.copyMissingMedia(); // in the background: never delays the journal (review 4 I4)
    this.schedule(this.opts.intervalMs);
  }

  private async follow(): Promise<void> {
    if (this.status.diverged !== null) {
      // Stopped following, but keep watching whether the primary is alive (the split-brain guard needs it).
      const res = await this.get(`${this.opts.primary.replace(/\/+$/, "")}/health`).catch(() => null);
      if (res !== null) this.status.lastContactAt = this.opts.clock();
      return;
    }
    let rt = this.opts.runtime();
    const ours = rt.current.events.at(-1)?.seq ?? 0;
    // Ask from our last event (not after it): it must be the same on the primary, else the journals forked.
    let from = Math.max(1, ours);
    for (let page = 0; page < 20; page++) {
      const res = await this.get(`${this.opts.primary.replace(/\/+$/, "")}/api/journal?from=${from}`);
      if (this.stopped) return; // promoted meanwhile: never touch the journal again (review 4 I1)
      // Any HTTP answer means the primary process is alive (even a 500 / 401): what the split-brain guard needs.
      this.status.lastContactAt = this.opts.clock();
      if (!res.ok) throw new Error(res.status === 401 ? "jeton régie du principal refusé (secret.key différent ?)" : `principal : HTTP ${res.status}`);
      const p = Page.parse(await res.json());
      if (this.stopped) return;
      if (p.build !== undefined && p.build !== this.opts.build) {
        this.status.diverged = `versions différentes (principal ${p.build}, secours ${this.opts.build}) : mettre les deux serveurs à la même version`;
        return;
      }
      if (p.session.id !== rt.session.id) {
        // The primary switched to another game: follow it (same session id, same seed → same states).
        if (!this.opts.hasSession(p.session.id)) this.opts.createSession(p.session);
        this.opts.openSession(p.session);
        rt = this.opts.runtime();
        rt.setStandby(true);
        from = 1;
        if (p.events[0]?.seq !== 1) continue; // fetch the new session from its start
      } else if (from === ours && ours > 0) {
        const anchor = p.events[0];
        if (anchor === undefined || anchor.seq !== ours || !rt.sameEventAt(anchor)) {
          this.status.diverged = `journal différent du principal à l'événement ${ours} : ne pas basculer sur ce secours (le réinitialiser)`;
          return;
        }
      }
      const r = rt.replicate(p.events);
      if (r.skipped > 0) {
        this.status.diverged = `${r.skipped} action(s) du principal refusée(s) ici : les états divergent`;
        return;
      }
      this.status.sessionId = p.session.id;
      this.status.lag = Math.max(0, p.lastSeq - (rt.current.events.at(-1)?.seq ?? 0));
      this.status.lastContactAt = this.opts.clock();
      this.status.error = null;
      if (p.next === null) return;
      from = p.next;
    }
  }

  private copying = false;

  /** Media referenced by the game and missing here, from the primary's public `/media/<hash>`, streamed. */
  private async copyMissingMedia(): Promise<void> {
    if (this.copying) return;
    this.copying = true;
    try {
      const missing = gameMediaHashes(this.opts.runtime().current.state.game).filter((h) => this.opts.media.pathOf(h) === null);
      this.status.mediaMissing = missing.length;
      for (const hash of missing) {
        if (this.stopped) return;
        const res = await this.opts.fetch(`${this.opts.primary.replace(/\/+$/, "")}/media/${hash}`, { signal: AbortSignal.timeout(120_000) }).catch(() => null);
        if (res === null || !res.ok || res.body === null) continue; // retried on a later tick
        const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0] ?? "application/octet-stream";
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fetch's web stream type vs node:stream/web's (same object)
        const stored = await this.opts.media.put(Readable.fromWeb(res.body as never), mime, hash).catch(() => null);
        if (stored?.hash === hash) {
          this.status.mediaCopied++;
          this.status.mediaMissing--;
        }
      }
    } finally {
      this.copying = false;
    }
  }

  /** The primary is down for good: this server takes the show over from its journal. */
  promote(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.status.mode = "promoted";
    this.opts.runtime().setStandby(false);
  }

  close(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
  }
}
