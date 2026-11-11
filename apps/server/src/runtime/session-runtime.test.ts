import { describe, expect, it } from "vitest";
import { defaultRegistry } from "@quiz/engine";
import { applyPatch, decodeServerMessage } from "@quiz/protocol";
import { DEMO_GAME, View, type Action, type Actor, type Session } from "@quiz/schema";
import { MemoryEventStore } from "../store/event-store.ts";
import { FakeTime, RecordingLog, silentLog } from "../testing/fakes.ts";
import { SessionRuntime, type ViewSink } from "./session-runtime.ts";
import { SLOW_CLIENT_BYTES, ViewStream } from "./view-stream.ts";

const session: Session = { schemaVersion: 1, id: "ses_rt", game: DEMO_GAME, seed: 42, createdAt: 0 };
const CTL: Actor = { role: "control", id: "c_op" };

function setup(store = new MemoryEventStore(), time = new FakeTime()) {
  if (store.getSession(session.id) === null) store.createSession(session);
  const rt = new SessionRuntime(store, defaultRegistry, session, time.clock, time, silentLog);
  let k = 0;
  const act = (action: Action, actor: Actor = CTL) => rt.submit(action, actor, `k_${String(k++).padStart(8, "0")}`);
  return { rt, store, time, act };
}

const toOpen = (act: (a: Action) => unknown) => {
  for (const a of [
    { type: "game.start" },
    { type: "player.add", participantId: "p_1", displayName: "Ana", seat: 1, channel: "seat" },
    { type: "round.start" },
    { type: "question.present" },
    
  ] as const satisfies readonly Action[]) act(a);
};

describe("SessionRuntime — journal before broadcast (non-negotiable #4)", () => {
  it("journals every accepted action before any client sees it", () => {
    const { rt, store, act } = setup();
    const seen: number[] = [];
    const sink: ViewSink = { viewer: { role: "control" }, update: (f) => seen.push(f.view.role === "control" ? store.events(session.id).length : -1) };
    rt.subscribe(sink);
    act({ type: "game.start" });
    act({ type: "player.add", participantId: "p_1", displayName: "Ana", channel: "seat" });
    // When each update was delivered, the matching event was already in the journal.
    expect(seen).toEqual([1, 2]);
  });

  it("refuses the action and broadcasts nothing when the journal write fails", () => {
    const { rt, store, act } = setup();
    let updates = 0;
    rt.subscribe({ viewer: { role: "control" }, update: () => updates++ });
    store.failNextAppend = true;
    const ack = act({ type: "game.start" });
    expect(ack).toMatchObject({ ok: false, code: "server-error" });
    expect(updates).toBe(0);
    expect(rt.current.state.phase).toBe("lobby");
    expect(act({ type: "game.start" })).toMatchObject({ ok: true, eventSeq: 1 }); // next try works
  });

  it("does not journal rejected actions", () => {
    const { store, act } = setup();
    expect(act({ type: "question.reveal" })).toMatchObject({ ok: false, code: "wrong-phase" });
    expect(store.events(session.id)).toHaveLength(0);
  });
});

describe("SessionRuntime — idempotency (ADR-0010)", () => {
  it("a replayed key returns the same ack without re-applying", () => {
    const { rt, store } = setup();
    const a1 = rt.submit({ type: "game.start" }, CTL, "k_dup00001");
    const a2 = rt.submit({ type: "game.start" }, CTL, "k_dup00001");
    expect(a2).toEqual(a1);
    expect(store.events(session.id)).toHaveLength(1);
  });

  it("…even after a server restart (keys rebuilt from the journal)", () => {
    const store = new MemoryEventStore();
    const first = setup(store);
    toOpen(first.act);
    const answer: Action = { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["b"] } };
    const before = first.rt.submit(answer, { role: "seat", id: "p_1" }, "k_answer01");
    first.rt.close();
    const second = setup(store);
    const after = second.rt.submit(answer, { role: "seat", id: "p_1" }, "k_answer01");
    expect(after).toEqual(before);
    expect(store.events(session.id).filter((e) => e.action.type === "answer.submit")).toHaveLength(1);
  });

  it("a replayed rejected key returns the same rejection", () => {
    const { rt } = setup();
    const r1 = rt.submit({ type: "question.reveal" }, CTL, "k_rej00001");
    rt.submit({ type: "game.start" }, CTL, "k_other001");
    expect(rt.submit({ type: "question.reveal" }, CTL, "k_rej00001")).toEqual(r1);
  });
});

describe("SessionRuntime — server timers", () => {
  it("injects timer.expired at the deadline (auto-lock)", () => {
    const { rt, time, act } = setup();
    toOpen(act);
    expect(rt.current.state.phase).toBe("open");
    time.advance(19_999);
    expect(rt.current.state.phase).toBe("open");
    time.advance(1);
    expect(rt.current.state.phase).toBe("locked");
    expect(rt.current.events.at(-1)?.actor).toEqual({ role: "system" });
  });

  it("re-arms timers from the journal after a crash and fires a deadline missed while down", () => {
    const store = new MemoryEventStore();
    const time = new FakeTime();
    const a = setup(store, time);
    toOpen(a.act);
    a.rt.close(); // crash
    time.now += 60_000; // server down for a minute
    const b = setup(store, time);
    expect(b.rt.current.state.phase).toBe("open");
    time.advance(0);
    expect(b.rt.current.state.phase).toBe("locked");
  });

  it("a lock before the deadline cancels the timer", () => {
    const { rt, time, act } = setup();
    toOpen(act);
    act({ type: "question.lock" });
    expect(time.armed).toBe(0);
    time.advance(30_000);
    expect(rt.current.state.lastSeq).toBe(5);
  });
});

describe("SessionRuntime — crash recovery from snapshot", () => {
  it("restarts to exactly the same state, with or without snapshots", () => {
    const store = new MemoryEventStore();
    const a = setup(store);
    toOpen(a.act);
    a.rt.submit({ type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["b"] } }, { role: "seat", id: "p_1" }, "k_ans00001");
    a.act({ type: "question.lock" });
    a.act({ type: "question.reveal" });
    a.act({ type: "question.next" });
    a.act({ type: "question.present" }); // writes a snapshot
    expect(store.latestSnapshot(session.id)).not.toBeNull();
    const b = setup(store);
    expect(b.rt.current.state).toEqual(a.rt.current.state);
  });

  it("ignores a corrupted snapshot (full replay) and says so", () => {
    const store = new MemoryEventStore();
    const a = setup(store);
    toOpen(a.act);
    store.saveSnapshot(session.id, 3, { garbage: true });
    const log = new RecordingLog();
    const b = new SessionRuntime(store, defaultRegistry, session, new FakeTime().clock, new FakeTime(), log);
    expect(b.current.state).toEqual(a.rt.current.state);
    expect(log.lines.some((l) => l.level === "warn")).toBe(true);
  });
});

function wire() {
  const sent: string[] = [];
  const w = { sent, buffered: 0, send: (d: string) => sent.push(d), get bufferedAmount() { return w.buffered; } };
  return w;
}

describe("ViewStream — patches, snapshots, slow clients (ADR-0009)", () => {

  it("client state rebuilt from welcome + patches equals the server view, with contiguous viewSeq", () => {
    const { rt, act } = setup();
    const w = wire();
    const stream = new ViewStream({ role: "output", scene: "program" }, w);
    stream.welcome(rt.view(stream.viewer), 0, 1);
    rt.subscribe(stream);
    toOpen(act);
    rt.submit({ type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["b"] } }, { role: "seat", id: "p_1" }, "k_ans00002");
    act({ type: "question.lock" });
    act({ type: "question.reveal" });

    let client: unknown = null;
    let seq = -1;
    let gaps = 0;
    for (const raw of w.sent) {
      const m = decodeServerMessage(raw);
      if (!m.ok) throw new Error(m.error.message);
      const msg = m.value;
      if (msg.t === "welcome" || msg.t === "snapshot") {
        client = msg.view;
        seq = msg.viewSeq;
      } else if (msg.t === "patch") {
        gaps += msg.viewSeq === seq + 1 ? 0 : 1;
        seq = msg.viewSeq;
        const r = applyPatch(client, msg.ops);
        if (!r.ok) throw new Error(r.error.message);
        client = r.value;
      }
    }
    expect(gaps).toBe(0);
    expect(View.parse(client)).toEqual(JSON.parse(JSON.stringify(rt.view(stream.viewer))));
    expect(w.sent.some((s) => s.includes('"t":"patch"'))).toBe(true);
  });

  it("stops queuing patches to a slow client and sends one snapshot once it caught up", () => {
    const { rt, act } = setup();
    const w = wire();
    const stream = new ViewStream({ role: "control" }, w);
    stream.welcome(rt.view(stream.viewer), 0, 1);
    rt.subscribe(stream);
    w.buffered = SLOW_CLIENT_BYTES + 1;
    toOpen(act);
    expect(w.sent).toHaveLength(1); // only the welcome
    w.buffered = 0;
    stream.flushIfCaughtUp();
    expect(w.sent).toHaveLength(2);
    expect(JSON.parse(w.sent[1] ?? "{}")).toMatchObject({ t: "snapshot", viewSeq: 1, view: { phase: "open" } });
  });

  it("one broken client never breaks the loop for others", () => {
    const { rt, act } = setup();
    let ok = 0;
    rt.subscribe({ viewer: { role: "control" }, update: () => { throw new Error("boom"); } });
    rt.subscribe({ viewer: { role: "control" }, update: () => ok++ });
    act({ type: "game.start" });
    expect(ok).toBe(1);
  });
});

function batched() {
  const store = new MemoryEventStore();
  store.createSession(session);
  const writes: number[] = [];
  const original = store.appendMany.bind(store);
  store.appendMany = (sid, evs) => {
    writes.push(evs.length);
    original(sid, evs);
  };
  const deferred: (() => void)[] = [];
  const time = new FakeTime();
  const rt = new SessionRuntime(store, defaultRegistry, session, time.clock, time, silentLog, { defer: (fn) => deferred.push(fn) });
  const flush = () => deferred.splice(0).forEach((f) => f());
  return { store, writes, rt, flush };
}

describe("SessionRuntime — group commit (ADR-0008)", () => {

  it("journals a burst of intents in ONE write, acks only after it, broadcasts once", () => {
    const { rt, writes, flush, store } = batched();
    let updates = 0;
    rt.subscribe({ viewer: { role: "control" }, update: () => updates++ });
    const acks: { journal: number }[] = [];
    rt.enqueue({ type: "game.start" }, CTL, "k_batch001", () => acks.push({ journal: store.events(session.id).length }));
    for (let i = 1; i <= 50; i++) rt.enqueue({ type: "player.add", participantId: `p_${i}`, displayName: `J${i}`, channel: "seat" }, CTL, `k_batch${String(i + 1).padStart(3, "0")}`, () => acks.push({ journal: store.events(session.id).length }));
    expect(acks).toHaveLength(0); // nothing acked before the commit
    flush();
    expect(writes).toEqual([51]);
    expect(acks).toHaveLength(51);
    expect(acks.every((x) => x.journal === 51)).toBe(true);
    expect(updates).toBe(1);
  });

  it("a failed batch write refuses every intent of the batch and changes nothing", () => {
    const { rt, store, flush } = batched();
    const acks: { ok: boolean }[] = [];
    store.failNextAppend = true;
    rt.enqueue({ type: "game.start" }, CTL, "k_fail0001", (a) => acks.push(a));
    rt.enqueue({ type: "player.add", participantId: "p_1", displayName: "A", channel: "seat" }, CTL, "k_fail0002", (a) => acks.push(a));
    flush();
    expect(acks.map((a) => a.ok)).toEqual([false, false]);
    expect(rt.current.state.phase).toBe("lobby");
    expect(rt.current.state.participants).toHaveLength(0);
  });

  it("the same key twice in one batch is applied once and acked identically", () => {
    const { rt, store, flush } = batched();
    const acks: unknown[] = [];
    rt.enqueue({ type: "game.start" }, CTL, "k_twice001", (a) => acks.push(a));
    rt.enqueue({ type: "game.start" }, CTL, "k_twice001", (a) => acks.push(a));
    flush();
    expect(store.events(session.id)).toHaveLength(1);
    expect(acks[0]).toEqual(acks[1]);
  });

  it("decisions inside a batch see each other (single writer, in order)", () => {
    const { rt, flush } = batched();
    const acks: { ok: boolean }[] = [];
    rt.enqueue({ type: "game.start" }, CTL, "k_order001", (a) => acks.push(a));
    rt.enqueue({ type: "game.start" }, CTL, "k_order002", (a) => acks.push(a)); // second start: wrong phase
    flush();
    expect(acks.map((a) => a.ok)).toEqual([true, false]);
  });
});
