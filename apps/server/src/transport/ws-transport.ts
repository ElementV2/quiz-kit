import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, decodeClientMessage, encode, type ErrorCode, type ServerMessage } from "@quiz/protocol";
import { assertNever } from "@quiz/engine";
import type { Actor, Viewer } from "@quiz/schema";
import type { Clock, Log, SessionRuntime } from "../runtime/session-runtime.ts";
import { ViewStream } from "../runtime/view-stream.ts";
import { verifyToken, viewerOf } from "../tokens.ts";

export type TransportDeps = {
  readonly runtime: () => SessionRuntime;
  readonly secret: string;
  readonly show: string;
  readonly isRevoked: (jti: string) => boolean;
  readonly clock: Clock;
  readonly log: Log;
  readonly helloTimeoutMs?: number;
  readonly heartbeatMs?: number;
};

/** Token bucket per connection (doc 04: rate limit per device). */
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
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

type Conn = {
  readonly ws: WebSocket;
  readonly limiter: RateLimiter;
  alive: boolean;
  rttMs: number | null;
  viewer: Viewer | null;
  clientId: string | null;
  stream: ViewStream | null;
  unsubscribe: (() => void) | null;
};

/** Same-origin check: browsers send Origin; bots and OBS-loaded pages from this server match the Host. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** WebSocket endpoint `/ws` (doc 04, ADR-0009). Attach it to every HTTP(S) server. */
export class WsTransport {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, clientTracking: false });
  private readonly conns = new Set<Conn>();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly deps: TransportDeps;

  constructor(deps: TransportDeps) {
    this.deps = deps;
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

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    this.wss.close();
  }

  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws, limiter: new RateLimiter(40, 20, this.deps.clock()), alive: true, rttMs: null, viewer: null, clientId: null, stream: null, unsubscribe: null };
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
      conn.alive = true;
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      conn.unsubscribe?.();
      this.conns.delete(conn);
    });
    ws.on("error", (e) => this.deps.log.warn({ err: e }, "erreur WebSocket"));
  }

  private onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (!conn.limiter.take(this.deps.clock())) {
      this.send(conn, { t: "error", code: "rate-limited", message: "trop de messages" });
      return;
    }
    if (isBinary) return this.fail(conn, "bad-message", "binaire refusé");
    const raw = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("utf8");
    const decoded = decodeClientMessage(raw);
    if (!decoded.ok) {
      this.send(conn, { t: "error", code: decoded.error.code, message: decoded.error.message });
      return;
    }
    const m = decoded.value;
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
        const ack = runtime.submit(m.action, actor, m.key);
        if (ack.key !== null) this.send(conn, ack.ok ? { t: "ack", key: ack.key, ok: true, eventSeq: ack.eventSeq ?? 0 } : { t: "ack", key: ack.key, ok: false, code: ack.code ?? "rejected", reason: ack.reason ?? "" });
        return;
      }
      case "pong":
        conn.rttMs = Math.max(0, this.deps.clock() - m.serverTime);
        return;
      case "resync":
        conn.stream?.resync(runtime.view(conn.viewer));
        return;
    }
  }

  private onHello(conn: Conn, v: number, token: string, clientId: string): void {
    if (v !== PROTOCOL_VERSION) return this.fail(conn, "unsupported-version", `protocole ${PROTOCOL_VERSION} attendu`);
    const r = verifyToken(this.deps.secret, token, { now: this.deps.clock(), show: this.deps.show, isRevoked: this.deps.isRevoked });
    if (!r.ok) return this.fail(conn, "unauthorized", `jeton refusé (${r.error})`);
    const viewer = viewerOf(r.claims);
    const runtime = this.deps.runtime();
    conn.viewer = viewer;
    conn.clientId = clientId;
    const stream = new ViewStream(viewer, { send: (d) => conn.ws.send(d), get bufferedAmount() { return conn.ws.bufferedAmount; } });
    conn.stream = stream;
    stream.welcome(runtime.view(viewer), this.deps.clock(), PROTOCOL_VERSION);
    conn.unsubscribe = runtime.subscribe(stream);
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
    for (const c of this.conns) {
      if (!c.alive) {
        c.ws.terminate(); // dead TCP: the client will reconnect and get a fresh snapshot
        continue;
      }
      c.alive = false;
      c.ws.ping();
      if (c.viewer !== null) this.send(c, { t: "ping", serverTime: now });
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
