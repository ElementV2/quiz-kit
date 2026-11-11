import { renameSync, readFileSync, writeFileSync } from "node:fs";
import { WebSocket } from "ws";
import { z } from "zod";
import type { ChatMessage } from "./ingest.ts";

/**
 * Twitch chat through EventSub over WebSocket (verified on dev.twitch.tv, see docs/api/chat.md):
 * - connect `wss://eventsub.wss.twitch.tv/ws`, wait for `session_welcome`, then within 10 s create a
 *   `channel.chat.message` v1 subscription (Helix POST /eventsub/subscriptions, transport websocket + session_id);
 * - never send anything (only automatic pongs, done by `ws`); no message for `keepalive_timeout_seconds` → the
 *   link is dead: new connection + new subscription (missed messages are not replayed);
 * - `session_reconnect` → open `reconnect_url` as is, keep the old socket until the new welcome.
 * Auth: Device Code Grant flow (public client, no secret): user token with scope `user:read:chat`; access tokens
 * last ~4 h, a public client's refresh token is single-use → saved atomically after every refresh.
 */

export const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const HELIX = "https://api.twitch.tv/helix";
const ID = "https://id.twitch.tv/oauth2";
const SCOPES = "user:read:chat";

export type Fetch = typeof fetch;
type Log = { info(o: object, msg: string): void; warn(o: object, msg: string): void };

const TokenFile = z.strictObject({ accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number() });
type Tokens = z.infer<typeof TokenFile>;

const Envelope = z.object({
  metadata: z.object({ message_id: z.string(), message_type: z.string() }),
  payload: z.unknown(),
});
const Welcome = z.object({ session: z.object({ id: z.string(), keepalive_timeout_seconds: z.number().nullable(), reconnect_url: z.string().nullable() }) });
const ChatEvent = z.object({
  event: z.object({
    broadcaster_user_id: z.string(),
    chatter_user_id: z.string(),
    message: z.object({ text: z.string() }),
    // Shared chat: messages of other channels arrive too (null = this channel).
    source_broadcaster_user_id: z.string().nullable().optional(),
  }),
});

export type TwitchStatus = {
  state: "off" | "login" | "connecting" | "live" | "error";
  channel: string | null;
  login: { verificationUri: string; userCode: string; expiresAt: number } | null;
  error: string | null;
  messages: number;
};

export class TwitchChat {
  readonly status: TwitchStatus = { state: "off", channel: null, login: null, error: null, messages: 0 };
  private ws: WebSocket | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private broadcasterId: string | null = null;
  private userId: string | null = null;
  private readonly seen = new Set<string>();
  private readonly opts: { clientId: string; tokenPath: string; onMessage: (m: ChatMessage) => void; log: Log; fetch?: Fetch; eventsubUrl?: string };

  constructor(opts: { clientId: string; tokenPath: string; onMessage: (m: ChatMessage) => void; log: Log; fetch?: Fetch; eventsubUrl?: string }) {
    this.opts = opts;
  }

  /** Every request gives up after 10 s: a hanging network must surface as an error, never freeze the connector. */
  private fetch(url: string, init: RequestInit = {}): Promise<Response> {
    return (this.opts.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(10_000) });
  }

  private readTokens(): Tokens | null {
    try {
      const r = TokenFile.safeParse(JSON.parse(readFileSync(this.opts.tokenPath, "utf8")));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  }

  /** Atomic write (tmp + rename): a crash mid-write must never lose the single-use refresh token. */
  private writeTokens(t: Tokens): void {
    const tmp = `${this.opts.tokenPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
    renameSync(tmp, this.opts.tokenPath);
  }

  get hasToken(): boolean {
    return this.readTokens() !== null;
  }

  /** Step 1 of the device flow: the operator opens `verificationUri` and types `userCode`. Polls in the background. */
  async startLogin(): Promise<{ verificationUri: string; userCode: string }> {
    this.loginGeneration++;
    const res = await this.fetch(`${ID}/device`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.opts.clientId, scopes: SCOPES }) });
    const body = z.object({ device_code: z.string(), user_code: z.string(), verification_uri: z.string(), expires_in: z.number(), interval: z.number() }).safeParse(await res.json());
    if (!res.ok || !body.success) throw new Error(`Twitch : connexion refusée (${res.status})`);
    const d = body.data;
    this.status.state = "login";
    this.status.login = { verificationUri: d.verification_uri, userCode: d.user_code, expiresAt: Date.now() + d.expires_in * 1000 };
    void this.pollToken(d.device_code, d.interval, Date.now() + d.expires_in * 1000, this.loginGeneration);
    return { verificationUri: d.verification_uri, userCode: d.user_code };
  }

  private loginGeneration = 0;

  private async pollToken(deviceCode: string, intervalS: number, until: number, generation: number): Promise<void> {
    // A newer login replaces this one (review 3 m7): the old poll stops silently.
    while (Date.now() < until && this.status.state === "login" && generation === this.loginGeneration) {
      await new Promise((r) => setTimeout(r, Math.max(1, intervalS) * 1000));
      const res = await this.fetch(`${ID}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.opts.clientId, scopes: SCOPES, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      }).catch(() => null);
      if (res === null) continue;
      const json: unknown = await res.json().catch(() => null);
      const ok = z.object({ access_token: z.string(), refresh_token: z.string(), expires_in: z.number() }).safeParse(json);
      if (ok.success) {
        this.writeTokens({ accessToken: ok.data.access_token, refreshToken: ok.data.refresh_token, expiresAt: Date.now() + ok.data.expires_in * 1000 });
        this.status.login = null;
        this.status.state = "off";
        this.opts.log.info({}, "Twitch : compte autorisé");
        return;
      }
      const pending = z.object({ message: z.string() }).safeParse(json);
      if (pending.success && pending.data.message !== "authorization_pending") {
        this.status.state = "error";
        this.status.error = `autorisation Twitch : ${pending.data.message}`;
        return;
      }
    }
    if (this.status.state === "login" && generation === this.loginGeneration) {
      this.status.state = "error";
      this.status.error = "code Twitch expiré : relancer la connexion";
    }
  }

  private refreshing: Promise<string> | null = null;

  /**
   * Valid access token (refreshed when < 5 min left; the new single-use refresh token is saved first).
   * One refresh at a time: two concurrent ones would spend the same single-use refresh token (review 3 I3).
   */
  private accessToken(): Promise<string> {
    const t = this.readTokens();
    if (t === null) return Promise.reject(new Error("compte Twitch non connecté"));
    if (t.expiresAt - Date.now() > 5 * 60_000) return Promise.resolve(t.accessToken);
    this.refreshing ??= this.refresh(t).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(t: Tokens): Promise<string> {
    const res = await this.fetch(`${ID}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.opts.clientId, grant_type: "refresh_token", refresh_token: t.refreshToken }) });
    const ok = z.object({ access_token: z.string(), refresh_token: z.string(), expires_in: z.number() }).safeParse(await res.json().catch(() => null));
    if (!ok.success) throw new Error("jeton Twitch expiré : reconnecter le compte");
    const next = { accessToken: ok.data.access_token, refreshToken: ok.data.refresh_token, expiresAt: Date.now() + ok.data.expires_in * 1000 };
    this.writeTokens(next);
    return next.accessToken;
  }

  private async helix(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    return this.fetch(`${HELIX}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "client-id": this.opts.clientId, "content-type": "application/json" } });
  }

  /** Reads `channel` (login name) chat as the authorised account. */
  async start(channel: string): Promise<void> {
    this.stop();
    this.stopped = false;
    this.status.channel = channel;
    this.status.error = null;
    this.status.state = "connecting";
    try {
      await this.resolveAndConnect(channel);
    } catch (err) {
      this.stopped = true;
      this.status.state = "error";
      this.status.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private async resolveAndConnect(channel: string): Promise<void> {
    const users = z.object({ data: z.array(z.object({ id: z.string(), login: z.string() })) });
    const me = users.safeParse(await (await this.helix("/users")).json());
    const ch = users.safeParse(await (await this.helix(`/users?login=${encodeURIComponent(channel)}`)).json());
    if (!me.success || me.data.data[0] === undefined) throw new Error("compte Twitch illisible");
    if (!ch.success || ch.data.data[0] === undefined) throw new Error(`chaîne Twitch inconnue : ${channel}`);
    this.userId = me.data.data[0].id;
    this.broadcasterId = ch.data.data[0].id;
    this.connect(this.opts.eventsubUrl ?? EVENTSUB_URL);
  }

  private connect(url: string, previous: WebSocket | null = null): void {
    const ws = new WebSocket(url);
    ws.on("message", (raw: Buffer) => {
      // Only the current socket (or the one taking over after a reconnect) may drive the connector.
      if (this.stopped || (ws !== this.ws && previous === null)) return;
      void this.onMessage(ws, raw.toString("utf8"), previous);
    });
    ws.on("close", () => {
      if (this.ws === ws && !this.stopped) this.reconnectFresh("connexion Twitch fermée");
    });
    ws.on("error", (err) => this.opts.log.warn({ err: err.message }, "Twitch EventSub : erreur"));
    if (previous === null) this.ws = ws;
  }

  /** Lost link (not a planned reconnect): new session, new subscription. */
  private disarm(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private reconnectFresh(why: string): void {
    this.disarm();
    this.opts.log.warn({ why }, "Twitch : reconnexion");
    const old = this.ws;
    this.ws = null;
    old?.removeAllListeners("close");
    old?.close();
    if (!this.stopped) setTimeout(() => !this.stopped && this.connect(this.opts.eventsubUrl ?? EVENTSUB_URL), 2000);
  }

  private armWatchdog(seconds: number | null): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    const s = seconds ?? 30;
    this.watchdog = setTimeout(() => this.reconnectFresh("keepalive manqué"), (s + 5) * 1000);
  }

  private keepaliveS: number | null = null;

  private async onMessage(ws: WebSocket, raw: string, previous: WebSocket | null): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const env = Envelope.safeParse(parsed);
    if (!env.success) return;
    const { message_id: id, message_type: type } = env.data.metadata;
    if (this.seen.has(id)) return; // cheap de-duplication (not documented as needed, harmless)
    this.seen.add(id);
    if (this.seen.size > 10_000) this.seen.clear();
    switch (type) {
      case "session_welcome": {
        const w = Welcome.safeParse(env.data.payload);
        if (!w.success) return;
        this.keepaliveS = w.data.session.keepalive_timeout_seconds;
        this.armWatchdog(this.keepaliveS);
        if (previous !== null) {
          // Planned reconnect: subscriptions follow; switch sockets, close the old one.
          this.ws = ws;
          previous.removeAllListeners("close");
          previous.close();
          this.status.state = "live";
          return;
        }
        await this.subscribe(w.data.session.id).catch((err: unknown) => {
          this.status.state = "error";
          this.status.error = err instanceof Error ? err.message : String(err);
        });
        return;
      }
      case "session_keepalive":
        this.armWatchdog(this.keepaliveS);
        return;
      case "session_reconnect": {
        const w = Welcome.safeParse(env.data.payload);
        if (w.success && w.data.session.reconnect_url !== null) this.connect(w.data.session.reconnect_url, ws);
        return;
      }
      case "notification": {
        this.armWatchdog(this.keepaliveS);
        const e = ChatEvent.safeParse(env.data.payload);
        if (!e.success) return;
        const ev = e.data.event;
        const source = ev.source_broadcaster_user_id ?? null;
        if (source !== null && source !== this.broadcasterId) return; // shared chat: other channel
        this.status.messages++;
        this.opts.onMessage({ platform: "tw", userId: ev.chatter_user_id, text: ev.message.text });
        return;
      }
      case "revocation":
        this.status.state = "error";
        this.status.error = "abonnement Twitch révoqué : reconnecter le compte";
        this.stop();
        return;
      default:
        return;
    }
  }

  private async subscribe(sessionId: string): Promise<void> {
    if (this.broadcasterId === null || this.userId === null) throw new Error("chaîne non résolue");
    const res = await this.helix("/eventsub/subscriptions", {
      method: "POST",
      body: JSON.stringify({ type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: this.broadcasterId, user_id: this.userId }, transport: { method: "websocket", session_id: sessionId } }),
    });
    if (res.status !== 202) throw new Error(`abonnement au chat refusé (${res.status})`);
    this.status.state = "live";
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners("close");
    ws?.close();
    if (this.status.state !== "error" && this.status.state !== "login") this.status.state = "off";
  }
}
