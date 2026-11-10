// Ambient k6 types: tools/k6/k6-env.d.ts (picked up by tsconfig "include").
import { WebSocket } from "k6/websockets";
import { Counter, Trend } from "k6/metrics";
import { PROTOCOL_VERSION, applyPatch, backoffDelay, checkViewSeq } from "@quiz/protocol/lite";

/**
 * One k6 VU = one tablet. Lean client on purpose: same wire protocol, same patches, same "resend un-acked intents
 * with the same key after a reconnect", but no Zod (500 VU runtimes × schemas = gigabytes). The full QuizClient is
 * exercised by the Node bots of `pnpm chaos`. The orchestrator compares `answers_acked` with the journal.
 */
const tokens = JSON.parse(open(__ENV["TOKENS"] ?? "")) as string[]; // oxlint-disable-line typescript/no-unsafe-type-assertion -- file written by tools/load.ts
const url = __ENV["URL"] ?? "ws://127.0.0.1:7312/ws";
const maxMs = Number(__ENV["MAX_MS"] ?? 300_000);

const acked = new Counter("answers_acked");
const rejected = new Counter("answers_rejected");
const unacked = new Counter("answers_unacked");
const ackLatency = new Trend("ack_latency", true);
const welcomeLatency = new Trend("welcome_latency", true);
const reconnects = new Counter("reconnects");
const closedAbnormal = new Counter("closed_1006");
const closedByServer = new Counter("closed_4000");
const closedOther = new Counter("closed_other");
const closeCode = new Trend("close_code");
const closeAtMs = new Trend("close_at_ms");

export const options = {
  scenarios: {
    tablets: { executor: "per-vu-iterations", vus: tokens.length, iterations: 1, maxDuration: `${Math.ceil(maxMs / 1000) + 60}s` },
  },
  thresholds: { ack_latency: ["p(95)<250"], answers_unacked: ["count<1"] },
};

/** The few view fields a tablet needs (views are trusted here: the server validates, the full client re-validates). */
type LiteView = {
  phase?: string;
  canAnswer?: boolean;
  myAnswer?: unknown;
  me?: { participantId: string } | null;
  question?: { id: string } | null;
  mechanic?: { options: { id: string }[] } | null;
};
type Msg = { t?: string; view?: unknown; viewSeq?: number; ops?: unknown; key?: string; ok?: boolean; code?: string; serverTime?: number };

export default function (): void {
  const token = tokens[__VU - 1] ?? "";
  const startedAt = Date.now();
  let ws: WebSocket | null = null;
  let view: LiteView | null = null;
  let viewSeq = -1;
  let attempt = 0;
  let welcomed = false;
  let done = false;
  const answered = new Set<string>();
  const pending = new Map<string, { action: unknown; t0: number }>();

  const send = (m: unknown): void => {
    if (ws !== null && ws.readyState === 1) ws.send(JSON.stringify(m));
  };

  const connect = (): void => {
    const sock = new WebSocket(url);
    ws = sock;
    sock.addEventListener("open", () => sock.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, token, clientId: `c_k6_${__VU}` })));
    sock.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      const m = JSON.parse(ev.data) as Msg; // oxlint-disable-line typescript/no-unsafe-type-assertion -- lean client, fields checked below
      if (m.t === "welcome" || m.t === "snapshot") {
        view = m.view as LiteView; // oxlint-disable-line typescript/no-unsafe-type-assertion -- trusted server view
        viewSeq = m.viewSeq ?? 0;
        if (m.t === "welcome") {
          attempt = 0;
          if (!welcomed) welcomeLatency.add(Date.now() - startedAt);
          welcomed = true;
          for (const [key, p] of pending) send({ t: "intent", key, action: p.action });
        }
      } else if (m.t === "patch" && view !== null) {
        if (checkViewSeq(viewSeq, m.viewSeq ?? -1) !== "next") {
          send({ t: "resync" });
          return;
        }
        const r = applyPatch(view, Array.isArray(m.ops) ? m.ops : []);
        if (!r.ok) {
          send({ t: "resync" });
          return;
        }
        view = r.value;
        viewSeq = m.viewSeq ?? viewSeq;
      } else if (m.t === "ack" && m.key !== undefined) {
        const p = pending.get(m.key);
        if (p === undefined) return;
        if (m.ok === false && m.code === "rate-limited") {
          setTimeout(() => send({ t: "intent", key: m.key, action: p.action }), 300);
          return;
        }
        pending.delete(m.key);
        ackLatency.add(Date.now() - p.t0);
        if (m.ok === true) acked.add(1);
        else rejected.add(1);
      } else if (m.t === "ping") {
        send({ t: "pong", clientTime: Date.now(), serverTime: m.serverTime ?? 0 });
      }
    });
    sock.addEventListener("close", (ev) => {
      if (done) return;
      reconnects.add(1);
      const code = (ev as { code?: number }).code; // oxlint-disable-line typescript/no-unsafe-type-assertion -- diagnostic
      if (code === 1006) closedAbnormal.add(1);
      else if (code === 4000) closedByServer.add(1);
      else closedOther.add(1);
      closeCode.add(code ?? -1);
      closeAtMs.add(Date.now() - startedAt);
      setTimeout(connect, backoffDelay(attempt++, Math.random()));
    });
  };
  connect();

  const tick = setInterval(() => {
    const v = view;
    if (v === null) return;
    if (v.phase === "game.end" || Date.now() - startedAt > maxMs) {
      if (pending.size > 0 && Date.now() - startedAt <= maxMs) return; // wait for the last acks
      unacked.add(pending.size);
      done = true;
      clearInterval(tick);
      ws?.close();
      return;
    }
    if (v.canAnswer === true && v.myAnswer === null && v.me && v.question && v.mechanic && !answered.has(v.question.id)) {
      answered.add(v.question.id);
      const choices = v.mechanic.options;
      const pick = choices[Math.floor(Math.random() * choices.length)]?.id ?? "a";
      const key = `k_${crypto.randomUUID().replaceAll("-", "")}`;
      const action = { type: "answer.submit", participantId: v.me.participantId, answer: { kind: "choice", optionIds: [pick] } };
      pending.set(key, { action, t0: Date.now() });
      send({ t: "intent", key, action });
    }
  }, 100);
}
