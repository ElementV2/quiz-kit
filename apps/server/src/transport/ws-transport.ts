import { cleanDisplayName } from "@quiz/schema";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, decodeClientMessage, encode, type ErrorCode, type ServerMessage } from "@quiz/protocol";
import { assertNever } from "@quiz/engine";
import type { Actor, Viewer } from "@quiz/schema";
import { toAckMessage, type Clock, type Log, type SessionRuntime } from "../runtime/session-runtime.ts";
import { ViewStream } from "../runtime/view-stream.ts";
import { verifyToken, viewerOf } from "../tokens.ts";

export type TransportDeps = {
  readonly runtime: () => SessionRuntime;
  readonly secret: string;
  readonly show: string;
  readonly isRevoked: (jti: string) => boolean;
  /** Wall clock: server time sent to clients, token expiry. */
  readonly clock: Clock;
  /** Monotonic clock (ms): rate limiting must not jump when Windows resyncs the wall clock. */
  readonly monotonic?: () => number;
  readonly log: Log;
  /** Media hashes of the current game, pushed after every welcome so clients preload them (doc 04 `preload`). */
  readonly preload?: (viewer: Viewer) => string[];
  readonly helloTimeoutMs?: number;
  readonly heartbeatMs?: number;
  /** Pings without pong before a connection is considered dead (Wi-Fi power saving tolerates a few). */
  readonly missedPongsAllowed?: number;
};

/** Token bucket per connection (doc 04: rate limit per device), on a monotonic clock. */
class RateLimiter {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly perSecond: number;
  constructor(capacity: number, perSecond: number, now: number) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
    this.last = now;
  }
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const THROTTLE_WINDOW_MS = 150;

/** Per-role budgets: the control room may legitimately burst (CSV import of 500 players, Stream Deck macros). */
const LIMITS = { staff: { capacity: 600, perSecond: 300 }, device: { capacity: 40, perSecond: 20 } } as const;

type Conn = {
  readonly ws: WebSocket;
  limiter: RateLimiter;
  /** After a throttled intent, every intent is throttled until this instant: order is preserved (FIFO). */
  throttledUntil: number;
  missedPongs: number;
  /** Last app-level ping sent: its stamp and the monotonic instant (its pong gives the round trip). */
  lastPing: { readonly serverTime: number; readonly mono: number } | null;
  viewer: Viewer | null;
  jti: string | null;
  clientId: string | null;
  stream: ViewStream | null;
  unsubscribe: (() => void) | null;
};

/** Same-origin check: browsers send Origin; bots and pages served by this server match the Host. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("utf8");
  return data.toString("utf8");
}

/** WebSocket endpoint `/ws` (doc 04, ADR-0009). Attach it to every HTTP(S) server. */
export class WsTransport {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, clientTracking: false });
  private readonly conns = new Set<Conn>();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly deps: TransportDeps;
  private readonly monotonic: () => number;

  constructor(deps: TransportDeps) {
    this.deps = deps;
    this.monotonic = deps.monotonic ?? (() => performance.now());
    this.heartbeat = setInterval(() => this.tick(), deps.heartbeatMs ?? 2000);
    this.heartbeat.unref();
  }

  attach(server: Server): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== "/ws" || !originAllowed(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  /** Who is connected right now (control-room checklist, doc 05). Seats by number, players by id, others by role. */
  presence(): { total: number; byRole: Record<string, number>; seats: number[]; players: string[] } {
    const byRole: Record<string, number> = {};
    const seats = new Set<number>();
    const players = new Set<string>();
    for (const c of this.conns) {
      const v = c.viewer;
      if (v === null || c.clientId?.startsWith("c_preview") === true) continue; // control-room preview
      byRole[v.role] = (byRole[v.role] ?? 0) + 1;
      if (v.role === "seat") seats.add(v.seat);
      if (v.role === "player") players.add(v.participantId);
    }
    return { total: this.conns.size, byRole, seats: [...seats].toSorted((a, b) => a - b), players: [...players] };
  }

  /** After a session switch: every connection gets a fresh welcome from the new runtime (no reconnect). */
  rewelcomeAll(): void {
    const runtime = this.deps.runtime();
    for (const c of this.conns) {
      if (c.viewer === null) continue;
      c.unsubscribe?.();
      const stream = new ViewStream(c.viewer, { send: (d) => c.ws.send(d), get bufferedAmount() { return c.ws.bufferedAmount; } });
      c.stream = stream;
      stream.welcome(runtime.welcomeView(c.viewer), this.deps.clock(), PROTOCOL_VERSION);
      c.unsubscribe = runtime.subscribe(stream);
    }
  }

  /**
   * Revocation takes effect immediately: the connection stops being served at once (no view, no intent), then is
   * closed — even a hostile client that ignores the close handshake can do nothing more.
   */
  disconnectJti(jti: string): number {
    let n = 0;
    for (const c of this.conns) {
      if (c.jti === jti) {
        c.viewer = null;
        c.jti = null;
        c.unsubscribe?.();
        c.unsubscribe = null;
        c.stream = null;
        this.send(c, { t: "error", code: "unauthorized", message: "jeton révoqué" });
        c.ws.terminate();
        n++;
      }
    }
    return n;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    this.wss.close();
  }

  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws, limiter: new RateLimiter(LIMITS.device.capacity, LIMITS.device.perSecond, this.monotonic()), missedPongs: 0, lastPing: null, throttledUntil: 0, viewer: null, jti: null, clientId: null, stream: null, unsubscribe: null };
    this.conns.add(conn);
    const helloTimer = setTimeout(() => {
      if (conn.viewer === null) this.fail(conn, "unauthorized", "hello attendu");
    }, this.deps.helloTimeoutMs ?? 5000);
    ws.on("message", (data: RawData, isBinary: boolean) => {
      try {
        this.onMessage(conn, data, isBinary);
      } catch (e) {
        this.deps.log.error({ err: e }, "erreur de traitement d'un message"); // never crash the loop for one client
        this.send(conn, { t: "error", code: "server-error", message: "erreur serveur" });
      }
    });
    ws.on("pong", () => {
      conn.missedPongs = 0;
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      conn.unsubscribe?.();
      this.conns.delete(conn);
    });
    ws.on("error", (e) => this.deps.log.warn({ err: e }, "erreur WebSocket"));
  }

  private onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    conn.missedPongs = 0; // any message proves the client is alive (some stacks answer protocol pings late)
    if (isBinary) return this.fail(conn, "bad-message", "binaire refusé");
    // Decode first (bounded by maxPayload) so a throttled intent gets an ack carrying its key:
    // the client then retries it instead of waiting forever for an ack that never comes.
    const decoded = decodeClientMessage(rawToString(data));
    const now = this.monotonic();
    let allowed = conn.limiter.take(now);
    if (decoded.ok && decoded.value.t === "intent") {
      // Once one intent is throttled, later ones are too for a short window, so none can overtake it.
      if (!allowed) conn.throttledUntil = now + THROTTLE_WINDOW_MS;
      else if (now < conn.throttledUntil) allowed = false;
    }
    if (!decoded.ok) {
      if (allowed) this.send(conn, { t: "error", code: decoded.error.code, message: decoded.error.message });
      return;
    }
    const m = decoded.value;
    if (!allowed) {
      if (m.t === "intent") this.send(conn, { t: "ack", key: m.key, ok: false, code: "rate-limited", reason: "trop de messages : réessayer" });
      else this.send(conn, { t: "error", code: "rate-limited", message: "trop de messages" });
      return;
    }
    if (conn.viewer === null) {
      if (m.t !== "hello") return this.fail(conn, "unauthorized", "hello attendu");
      return this.onHello(conn, m.v, m.token, m.clientId);
    }
    const runtime = this.deps.runtime();
    switch (m.t) {
      case "hello":
        this.send(conn, { t: "error", code: "bad-message", message: "hello déjà reçu" });
        return;
      case "intent": {
        const actor = this.actorFor(conn.viewer, conn.clientId, runtime);
        if (actor === null) {
          this.send(conn, { t: "ack", key: m.key, ok: false, code: "forbidden", reason: "siège non assigné" });
          return;
        }
        const key = m.key;
        const raw = m.action;
        const action = raw.type === "player.add" || raw.type === "player.rename" ? { ...raw, displayName: cleanDisplayName(raw.displayName) } : raw;
        if ((action.type === "player.add" || action.type === "player.rename") && action.displayName === "") {
          this.send(conn, { t: "ack", key, ok: false, code: "invalid", reason: "nom vide (caractères invisibles retirés)" });
          return;
        }
        runtime.enqueue(action, actor, key, (ack) => this.send(conn, toAckMessage({ ...ack, key })));
        return;
      }
      case "pong": {
        // Only the answer to the last ping counts (a stale or forged stamp is ignored); monotonic clock, so a wall
        // clock resync never fakes a round trip. The client pairs it with the moment it received that ping.
        const last = conn.lastPing;
        if (last === null || m.serverTime !== last.serverTime) return;
        conn.lastPing = null;
        this.send(conn, { t: "clock", serverTime: last.serverTime, rttMs: Math.max(0, this.monotonic() - last.mono) });
        return;
      }
      case "resync":
        conn.stream?.resync(runtime.welcomeView(conn.viewer));
        return;
      default:
        return assertNever(m);
    }
  }

  private onHello(conn: Conn, v: number, token: string, clientId: string): void {
    if (v !== PROTOCOL_VERSION) return this.fail(conn, "unsupported-version", `protocole ${PROTOCOL_VERSION} attendu`);
    const r = verifyToken(this.deps.secret, token, { now: this.deps.clock(), show: this.deps.show, isRevoked: this.deps.isRevoked });
    if (!r.ok) return this.fail(conn, "unauthorized", `jeton refusé (${r.error})`);
    const viewer = viewerOf(r.claims);
    const runtime = this.deps.runtime();
    conn.viewer = viewer;
    conn.jti = r.claims.jti;
    const staff = viewer.role === "control" || viewer.role === "scorer" || viewer.role === "host" || viewer.role === "control-readonly";
    const budget = staff ? LIMITS.staff : LIMITS.device;
    conn.limiter = new RateLimiter(budget.capacity, budget.perSecond, this.monotonic());
    conn.clientId = clientId;
    const stream = new ViewStream(viewer, { send: (d) => conn.ws.send(d), get bufferedAmount() { return conn.ws.bufferedAmount; } });
    conn.stream = stream;
    stream.welcome(runtime.welcomeView(viewer), this.deps.clock(), PROTOCOL_VERSION);
    conn.unsubscribe = runtime.subscribe(stream);
    const hashes = this.deps.preload?.(viewer) ?? [];
    if (hashes.length > 0) this.send(conn, { t: "preload", hashes });
    this.evictOthers(conn, viewer);
  }

  /**
   * One device per seat and per player: the newest opening takes it (a refresh, or the tablet replacing a broken
   * one). The older one is told, stops at once (no more views, its intents refused) and is closed hard shortly
   * after — never two screens answering for the same player. Called once the new one is welcomed.
   */
  private evictOthers(conn: Conn, viewer: Viewer): void {
    if (viewer.role !== "seat" && viewer.role !== "player") return;
    const same = (other: Viewer | null): boolean =>
      other !== null && ((viewer.role === "seat" && other.role === "seat" && other.seat === viewer.seat) || (viewer.role === "player" && other.role === "player" && other.participantId === viewer.participantId));
    for (const c of this.conns) {
      if (c === conn || !same(c.viewer)) continue;
      this.send(c, { t: "error", code: "taken-over", message: viewer.role === "seat" ? `Le siège ${viewer.seat} est maintenant ouvert sur un autre appareil.` : "Ce joueur est maintenant ouvert sur un autre appareil (ou un autre onglet)." });
      c.unsubscribe?.();
      c.unsubscribe = null;
      c.viewer = null; // any further intent is refused (« hello attendu »)
      c.ws.close(4001, "taken-over");
      const ws = c.ws;
      setTimeout(() => {
        if (ws.readyState !== ws.CLOSED) ws.terminate();
      }, 1500).unref();
    }
  }

  /** The server stamps the actor from the token, never from the message (non-negotiable #2). */
  private actorFor(viewer: Viewer, clientId: string | null, runtime: SessionRuntime): Actor | null {
    switch (viewer.role) {
      case "player":
        return { role: "player", id: viewer.participantId };
      case "seat": {
        const pid = runtime.participantAtSeat(viewer.seat);
        return pid === null ? null : { role: "seat", id: pid };
      }
      case "output":
        return { role: "output" };
      case "control":
      case "control-readonly":
      case "scorer":
      case "host":
      case "studio":
        return clientId === null ? { role: viewer.role } : { role: viewer.role, id: clientId };
      default:
        return assertNever(viewer);
    }
  }

  private tick(): void {
    const now = this.deps.clock();
    const allowed = this.deps.missedPongsAllowed ?? 3;
    for (const c of this.conns) {
      if (c.missedPongs >= allowed) {
        c.ws.terminate(); // dead TCP: the client will reconnect and get a fresh snapshot
        continue;
      }
      c.missedPongs += 1;
      c.ws.ping();
      if (c.viewer !== null) {
        c.lastPing = { serverTime: now, mono: this.monotonic() };
        this.send(c, { t: "ping", serverTime: now });
      }
      c.stream?.flushIfCaughtUp();
    }
  }

  private send(conn: Conn, m: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(encode(m));
  }

  private fail(conn: Conn, code: ErrorCode, message: string): void {
    this.send(conn, { t: "error", code, message });
    conn.ws.close(4000, code);
  }
}
