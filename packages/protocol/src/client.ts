import { View, type Action, type Viewer } from "@quiz/schema";
import { decodeServerMessage, encode } from "./codec.ts";
import { PROTOCOL_VERSION, type AckMessage, type ClientMessage } from "./messages.ts";
import { applyPatch } from "./patch.ts";
import { ClockEstimator, backoffDelay, checkViewSeq } from "./timing.ts";

/**
 * Shared real-time client (doc 04): used by every front app, the bots and the load tests.
 * No Node / DOM API is touched directly — socket, storage, time and randomness are injected.
 */

/** Browser-like WebSocket surface (browser WebSocket, Node 22+ global WebSocket, k6/websockets). */
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
};

export type PendingIntent = { readonly key: string; readonly action: Action };

/** Persistence of un-acked intents (IndexedDB on `player`, memory in tests / bots). */
export type IntentStore = {
  load(): PendingIntent[];
  save(pending: readonly PendingIntent[]): void;
};

export const memoryIntentStore = (): IntentStore => {
  let items: PendingIntent[] = [];
  return { load: () => [...items], save: (p) => (items = [...p]) };
};

/** `taken`: this seat / player was opened on another device: no reconnect (the two would fight for it). */
export type ClientStatus = "connecting" | "open" | "reconnecting" | "rejected" | "taken" | "stopped";

export type ClientOptions = {
  readonly url: string;
  readonly token: string;
  readonly clientId: string;
  readonly socket: (url: string) => SocketLike;
  readonly store?: IntentStore;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
  /** Makes idempotency keys (UUID-like). */
  readonly newKey?: () => string;
  readonly onView?: (view: View) => void;
  readonly onStatus?: (status: ClientStatus, detail?: string) => void;
  readonly onAck?: (ack: AckMessage, action: Action) => void;
  /** Media hashes to preload (sent by the server after each welcome). */
  readonly onPreload?: (hashes: readonly string[]) => void;
};

const OPEN = 1;

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

/**
 * Idempotency key from 128 random bits. `crypto.getRandomValues` is the only Crypto member available in insecure
 * contexts (MDN) — tablets load the app over plain http://<LAN-IP>, where `crypto.randomUUID` does not exist.
 */
function defaultKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `k_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** localStorage-backed queue (available over plain HTTP, survives a reload; IndexedDB is not needed for a few intents). */
export function localStorageIntentStore(key: string, storage: Pick<Storage, "getItem" | "setItem">): IntentStore {
  return {
    load: () => {
      try {
        const raw: unknown = JSON.parse(storage.getItem(key) ?? "[]");
        return Array.isArray(raw) ? raw.filter((p): p is PendingIntent => typeof p === "object" && p !== null && "key" in p && "action" in p) : [];
      } catch {
        return [];
      }
    },
    save: (pending) => {
      try {
        storage.setItem(key, JSON.stringify(pending));
      } catch {
        /* storage blocked or full: the in-memory queue still works until reload */
      }
    },
  };
}

export class QuizClient {
  private ws: SocketLike | null = null;
  private attempt = 0;
  private cancelRetry: (() => void) | null = null;
  private pending: PendingIntent[];
  private readonly waiters = new Map<string, (ack: AckMessage) => void>();
  private readonly clock = new ClockEstimator();
  private seq = -1;
  private resendScheduled = false;
  private status: ClientStatus = "stopped";
  private readonly o: Required<Omit<ClientOptions, "onView" | "onStatus" | "onAck" | "onPreload">> & Pick<ClientOptions, "onView" | "onStatus" | "onAck" | "onPreload">;
  view: View | null = null;
  viewer: Viewer | null = null;

  constructor(options: ClientOptions) {
    this.o = {
      store: memoryIntentStore(),
      now: Date.now,
      random: Math.random,
      setTimer: defaultTimer,
      newKey: defaultKey,
      ...options,
    };
    this.pending = this.o.store.load();
  }

  get state(): ClientStatus {
    return this.status;
  }

  /** Intents not acknowledged yet (survive reloads through the IntentStore). */
  get queued(): readonly PendingIntent[] {
    return this.pending;
  }

  /** Server time estimate (ms) — use it for countdowns (`view.timer.endsAt - serverNow()`). */
  serverNow(): number {
    return this.o.now() + this.clock.offsetMs;
  }

  start(): void {
    if (this.status !== "stopped") return;
    this.connect("connecting");
  }

  stop(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.setStatus("stopped");
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "stop");
  }

  /**
   * Queues an intent (persisted), sends it now if connected, resends it after every reconnect until
   * acked. Resolves with the server's ack — the UI shows "Réponse enregistrée" only then (doc 04).
   */
  submit(action: Action): Promise<AckMessage> {
    const key = this.o.newKey();
    this.pending = [...this.pending, { key, action }];
    this.o.store.save(this.pending);
    const p = new Promise<AckMessage>((resolve) => this.waiters.set(key, resolve));
    this.send({ t: "intent", key, action });
    return p;
  }

  /** Simulates a network drop (tests, chaos): closes the socket without stopping the client. */
  dropConnection(): void {
    this.ws?.close(4999, "drop");
  }

  private connect(status: ClientStatus): void {
    this.setStatus(status);
    let ws: SocketLike;
    try {
      ws = this.o.socket(this.o.url);
    } catch (e) {
      this.scheduleReconnect(String(e));
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => ws.send(encode({ t: "hello", v: PROTOCOL_VERSION, token: this.o.token, clientId: this.o.clientId })));
    ws.addEventListener("message", (ev) => {
      if (this.ws === ws && typeof ev.data === "string") this.onMessage(ev.data);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.status !== "stopped" && this.status !== "rejected" && this.status !== "taken") this.scheduleReconnect();
    });
    // "error" is always followed by "close", which drives reconnection.
  }

  private scheduleReconnect(detail?: string): void {
    this.setStatus("reconnecting", detail);
    const delay = backoffDelay(this.attempt++, this.o.random());
    this.cancelRetry = this.o.setTimer(() => {
      this.cancelRetry = null;
      if (this.status === "reconnecting") this.connect("reconnecting");
    }, delay);
  }

  private onMessage(raw: string): void {
    const d = decodeServerMessage(raw);
    if (!d.ok) return; // ignore garbage; a real gap will be caught by viewSeq
    const m = d.value;
    switch (m.t) {
      case "welcome":
        this.attempt = 0;
        this.viewer = m.viewer;
        this.clock.add({ offsetMs: m.serverTime - this.o.now(), rttMs: 0 });
        this.setView(m.view, m.viewSeq);
        this.setStatus("open");
        for (const p of this.pending) this.send({ t: "intent", key: p.key, action: p.action });
        return;
      case "snapshot":
        this.setView(m.view, m.viewSeq);
        return;
      case "patch": {
        const check = checkViewSeq(this.seq, m.viewSeq);
        if (check === "duplicate") return;
        if (check === "gap" || this.view === null) return this.resync();
        const r = applyPatch(this.view, m.ops);
        const v = r.ok ? View.safeParse(r.value) : null;
        if (v === null || !v.success) return this.resync();
        this.setView(v.data, m.viewSeq);
        return;
      }
      case "ack": {
        if (!m.ok && m.code === "rate-limited") {
          // Throttled, not refused: keep it queued; resend the whole queue IN ORDER a bit later (same keys).
          if (!this.resendScheduled) {
            this.resendScheduled = true;
            this.o.setTimer(() => {
              this.resendScheduled = false;
              for (const p of this.pending) this.send({ t: "intent", key: p.key, action: p.action });
            }, 200 + this.o.random() * 300);
          }
          return;
        }
        const p = this.pending.find((x) => x.key === m.key);
        this.pending = this.pending.filter((x) => x.key !== m.key);
        this.o.store.save(this.pending);
        if (p !== undefined) this.o.onAck?.(m, p.action);
        this.waiters.get(m.key)?.(m);
        this.waiters.delete(m.key);
        return;
      }
      case "ping":
        // One-way sample: on a LAN the bias is half a millisecond-scale RTT.
        this.clock.add({ offsetMs: m.serverTime - this.o.now(), rttMs: 0 });
        this.send({ t: "pong", clientTime: this.o.now(), serverTime: m.serverTime });
        return;
      case "preload":
        this.o.onPreload?.(m.hashes);
        return;
      case "error":
        if (m.code === "unauthorized" || m.code === "unsupported-version") {
          this.setStatus("rejected", m.message); // retrying would never help
          this.ws?.close(1000, "rejected");
        } else if (m.code === "taken-over") {
          this.setStatus("taken", m.message);
          this.ws?.close(1000, "taken");
        }
        return;
    }
  }

  private resync(): void {
    this.send({ t: "resync" });
  }

  private setView(view: View, viewSeq: number): void {
    this.view = view;
    this.seq = viewSeq;
    this.o.onView?.(view);
  }

  private setStatus(s: ClientStatus, detail?: string): void {
    if (this.status === s) return;
    this.status = s;
    this.o.onStatus?.(s, detail);
  }

  private send(m: ClientMessage): void {
    // Before the welcome nothing is sent: queued intents go out right after it.
    if (this.ws !== null && this.ws.readyState === OPEN && this.status === "open") this.ws.send(encode(m));
  }
}
