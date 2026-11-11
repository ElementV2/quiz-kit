import { describe, expect, it } from "vitest";
import { View } from "@quiz/schema";
import { QuizClient, memoryIntentStore, type SocketLike } from "./client.ts";
import { diff } from "./patch.ts";

/** Fake socket driven by the test (acts as the server side). */
const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v)) : {});

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  private readonly listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  private emit(type: string, ev: { data?: unknown } = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  send(data: string): void {
    this.sent.push(asRecord(JSON.parse(data)));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  push(m: unknown): void {
    this.emit("message", { data: JSON.stringify(m) });
  }
  ofType(t: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m["t"] === t);
  }
}

const view = (phase: string, extra: Record<string, unknown> = {}): View =>
  View.parse({ role: "output", sessionId: "ses_1", phase, round: null, question: null, timer: null, mechanic: null, leaderboard: [], ...extra });

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let k = 0;
  const views: View[] = [];
  const statuses: string[] = [];
  const store = memoryIntentStore();
  const client = new QuizClient({
    url: "ws://x/ws",
    token: "tok",
    clientId: "c_1",
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    store,
    now: () => 1000,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
    newKey: () => `k_test${String(k++).padStart(4, "0")}`,
    onView: (v) => views.push(v),
    onStatus: (s) => statuses.push(s),
  });
  const last = (): FakeSocket => {
    const s = sockets.at(-1);
    if (s === undefined) throw new Error("no socket");
    return s;
  };
  const welcome = (s: FakeSocket, v: View = view("lobby")) => s.push({ t: "welcome", v: 1, viewer: { role: "output", scene: "program" }, serverTime: 1500, viewSeq: 0, view: v });
  return { client, sockets, timers, views, statuses, store, last, welcome };
}

describe("QuizClient", () => {
  it("says hello, takes the welcome snapshot, then applies patches in order", () => {
    const { client, last, welcome, views } = setup();
    client.start();
    last().open();
    expect(last().sent[0]).toMatchObject({ t: "hello", v: 1, token: "tok", clientId: "c_1" });
    welcome(last());
    last().push({ t: "patch", viewSeq: 1, ops: diff(view("lobby"), view("idle")) });
    expect(client.view?.phase).toBe("idle");
    expect(views.map((v) => v.phase)).toEqual(["lobby", "idle"]);
    expect(client.serverNow()).toBe(1500);
  });

  it("asks for a snapshot on a sequence gap and ignores duplicates", () => {
    const { client, last, welcome } = setup();
    client.start();
    last().open();
    welcome(last());
    last().push({ t: "patch", viewSeq: 3, ops: [] });
    expect(last().ofType("resync")).toHaveLength(1);
    last().push({ t: "snapshot", viewSeq: 3, view: view("open") });
    last().push({ t: "patch", viewSeq: 3, ops: diff(view("open"), view("locked")) }); // duplicate
    expect(client.view?.phase).toBe("open");
  });

  it("resyncs when a patch does not apply or yields an invalid view", () => {
    const { client, last, welcome } = setup();
    client.start();
    last().open();
    welcome(last());
    last().push({ t: "patch", viewSeq: 1, ops: [{ op: "replace", path: "/phase", value: "nonsense" }] });
    expect(last().ofType("resync")).toHaveLength(1);
    expect(client.view?.phase).toBe("lobby");
  });

  it("queues intents while offline, sends them after the welcome, resolves on ack", async () => {
    const { client, last, welcome, store } = setup();
    client.start();
    const p = client.submit({ type: "game.start" });
    expect(store.load()).toHaveLength(1); // persisted before anything is sent
    last().open();
    expect(last().ofType("intent")).toHaveLength(0); // nothing before welcome
    welcome(last());
    const [intent] = last().ofType("intent");
    expect(intent).toMatchObject({ key: "k_test0000", action: { type: "game.start" } });
    last().push({ t: "ack", key: "k_test0000", ok: true, eventSeq: 1 });
    await expect(p).resolves.toMatchObject({ ok: true, eventSeq: 1 });
    expect(store.load()).toHaveLength(0);
  });

  it("re-sends un-acked intents with the SAME key after a drop (idempotent on the server)", () => {
    const { client, last, welcome, timers, statuses } = setup();
    client.start();
    last().open();
    welcome(last());
    void client.submit({ type: "game.start" });
    const first = last();
    first.close(); // Wi-Fi drop before the ack
    expect(statuses.at(-1)).toBe("reconnecting");
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBeLessThanOrEqual(100); // first retry is quick
    timers[0]?.fn();
    last().open();
    welcome(last());
    expect(last().ofType("intent").map((m) => m["key"])).toEqual(["k_test0000"]);
    expect(first.ofType("intent").map((m) => m["key"])).toEqual(["k_test0000"]);
  });

  it("restores the queue from the store after a reload", () => {
    const a = setup();
    a.client.start();
    void a.client.submit({ type: "question.open" });
    const reloaded = new QuizClient({ url: "ws://x", token: "t", clientId: "c_1", socket: () => new FakeSocket(), store: a.store });
    expect(reloaded.queued).toEqual([{ key: "k_test0000", action: { type: "question.open" } }]);
  });

  it("stops retrying when the token is refused", () => {
    const { client, last, timers, statuses } = setup();
    client.start();
    last().open();
    last().push({ t: "error", code: "unauthorized", message: "jeton refusé" });
    expect(statuses.at(-1)).toBe("rejected");
    expect(timers).toHaveLength(0);
  });

  it("answers pings with a pong", () => {
    const { client, last, welcome } = setup();
    client.start();
    last().open();
    welcome(last());
    last().push({ t: "ping", serverTime: 2000 });
    expect(last().ofType("pong")[0]).toMatchObject({ serverTime: 2000, clientTime: 1000 });
  });

  it("pairs the server's measured round trip with the ping it belongs to (clock offset)", () => {
    const { client, last, welcome } = setup();
    client.start();
    last().open();
    welcome(last()); // one-way: +500
    last().push({ t: "ping", serverTime: 1600 }); // received at 1000: one-way +600
    last().push({ t: "clock", serverTime: 1600, rttMs: 40 }); // it took ~20 ms: +620, measured → trusted
    expect(client.serverNow()).toBe(1620);
    last().push({ t: "clock", serverTime: 9999, rttMs: 0 }); // no such ping: ignored
    expect(client.serverNow()).toBe(1620);
  });

  it("stop() closes for good", () => {
    const { client, last, timers } = setup();
    client.start();
    last().open();
    client.stop();
    expect(client.state).toBe("stopped");
    expect(timers).toHaveLength(0);
  });
});

describe("QuizClient — throttling", () => {
  it("a rate-limited intent stays queued and is resent with the same key", async () => {
    const { client, last, welcome, timers } = setup();
    client.start();
    last().open();
    welcome(last());
    const p = client.submit({ type: "game.start" });
    last().push({ t: "ack", key: "k_test0000", ok: false, code: "rate-limited", reason: "trop de messages" });
    expect(client.queued).toHaveLength(1);
    timers.at(-1)?.fn();
    expect(last().ofType("intent").map((m) => m["key"])).toEqual(["k_test0000", "k_test0000"]);
    last().push({ t: "ack", key: "k_test0000", ok: true, eventSeq: 1 });
    await expect(p).resolves.toMatchObject({ ok: true });
  });
});

describe("QuizClient — throttling keeps order", () => {
  it("after a rate-limited ack, the whole queue is resent in submission order", () => {
    const { client, last, welcome, timers } = setup();
    client.start();
    last().open();
    welcome(last());
    void client.submit({ type: "question.present" }); // k_test0000
    void client.submit({ type: "question.open" }); // k_test0001
    last().push({ t: "ack", key: "k_test0000", ok: false, code: "rate-limited", reason: "x" });
    last().push({ t: "ack", key: "k_test0001", ok: false, code: "rate-limited", reason: "x" });
    expect(timers).toHaveLength(1); // one resend for the whole queue
    timers[0]?.fn();
    expect(last().ofType("intent").map((m) => m["key"])).toEqual(["k_test0000", "k_test0001", "k_test0000", "k_test0001"]);
  });
});
