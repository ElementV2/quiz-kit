import type { Action, MechanicView, View } from "@quiz/schema";
import type { SessionRuntime, Timers } from "./runtime/session-runtime.ts";

/**
 * Rehearsal mode (doc 07 « Mode Répétition »): simulated players that answer through the normal pipeline
 * (journal, acks, projections — exactly like tablets) to try a format and its scenes without people.
 * Bots are ordinary participants (`p_bot_<n>`, channel `play`); they read the control view to aim at the right
 * answer with the requested accuracy. Rehearsal only: never start it during a real show.
 */

export const BOT_PREFIX = "p_bot_";
export const isBot = (participantId: string): boolean => participantId.startsWith(BOT_PREFIX);

export type BotSettings = { readonly bots: number; readonly accuracy: number; readonly latencyMs: number };

type Rand = () => number;

const pick = <T>(xs: readonly T[], rand: Rand): T | undefined => xs[Math.floor(rand() * xs.length)];
const shuffled = <T>(xs: readonly T[], rand: Rand): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
};

const WRONG_TEXT = ["Je ne sais pas", "Aucune idée", "Paris", "42"];

/** What one bot does on an open question (pure; `rand` in [0, 1)). Null: nothing a bot can do here. */
export function botAction(m: MechanicView, participantId: string, rand: Rand, accuracy: number): Action | null {
  const right = rand() < accuracy;
  const submit = (answer: Extract<Action, { type: "answer.submit" }>["answer"]): Action => ({ type: "answer.submit", participantId, answer });
  switch (m.mechanic) {
    case "choice": {
      const ids = m.options.map((o) => o.id);
      if (right && m.correct !== null) return submit({ kind: "choice", optionIds: m.correct.slice(0, m.maxPick) });
      const wrong = ids.filter((id) => !(m.correct ?? []).includes(id));
      const one = pick(wrong.length > 0 ? wrong : ids, rand);
      return one === undefined ? null : submit({ kind: "choice", optionIds: [one] });
    }
    case "ladder": {
      if (m.candidate !== null && m.candidate !== participantId) return null;
      const open = m.options.filter((o) => !m.hidden.includes(o.id)).map((o) => o.id);
      const id = right && m.correct !== null ? m.correct : pick(open.filter((x) => x !== m.correct), rand);
      return id === undefined ? null : submit({ kind: "choice", optionIds: [id] });
    }
    case "buzzer":
    case "board":
      return m.winner === null ? { type: "buzz", participantId } : null;
    case "poll-board":
      return null; // answers are spoken and judged by the host
    case "crowd-vote":
      return null; // the chat votes, not the players
    case "text-answer":
      return submit({ kind: "text", text: right && m.correct !== null ? m.correct : (pick(WRONG_TEXT, rand) ?? "?") });
    case "number-answer": {
      const c = m.correct ?? 0;
      const spread = Math.max(Math.abs(c) * 0.5, 10);
      // Right: anywhere inside the tolerance (not rounded: a 0.1 tolerance on 3.14 must stay right).
      const raw = right ? c + (rand() - 0.5) * 2 * (m.tolerance ?? 0) * 0.99 : Math.round(c + (rand() < 0.5 ? -1 : 1) * spread * (0.2 + rand()));
      const value = Math.min(m.max ?? Infinity, Math.max(m.min ?? -Infinity, raw));
      return submit({ kind: "number", value });
    }
    case "order": {
      const ids = m.options.map((o) => o.id);
      const mixed = shuffled(ids, rand);
      return submit({ kind: "order", optionIds: right && m.correct !== null ? m.correct : mixed });
    }
    case "pairs": {
      if (m.correct === null) return null;
      if (right) return submit({ kind: "pairs", matches: m.correct.map((c) => ({ ...c })) });
      const rights = shuffled(m.right.map((r) => r.id), rand);
      return submit({ kind: "pairs", matches: m.left.map((l, i) => ({ left: l.id, right: rights[i] ?? "r0" })) });
    }
    case "pin": {
      const t = m.correct;
      if (right && t !== null) return submit({ kind: "pin", x: t.x + t.w * rand(), y: t.y + t.h * rand() });
      return submit({ kind: "pin", x: rand(), y: rand() });
    }
    case "allocation": {
      const wrong = m.options.filter((o) => o.id !== m.correct);
      const target = right && m.correct !== null ? m.correct : pick(wrong, rand)?.id;
      return target === undefined ? null : submit({ kind: "allocation", amounts: [{ optionId: target, amount: m.budget }] });
    }
    case "hints":
    case "reveal-image": {
      if (m.input === "text") return submit({ kind: "text", text: right && m.correct !== null ? m.correct : (pick(WRONG_TEXT, rand) ?? "?") });
      const ids = (m.options ?? []).map((o) => o.id);
      const id = right && m.correct !== null ? m.correct : pick(ids.filter((x) => x !== m.correct), rand);
      return id === undefined ? null : submit({ kind: "choice", optionIds: [id] });
    }
    default:
      return null;
  }
}

/** Waits for every queued intent to be committed (one group commit for all of them). */
function enqueueAll(rt: SessionRuntime, actions: readonly Action[]): Promise<number> {
  if (actions.length === 0) return Promise.resolve(0);
  return new Promise((resolve) => {
    let left = actions.length;
    let ok = 0;
    for (const action of actions) {
      rt.enqueue(action, { role: "control", id: "rehearsal" }, null, (ack) => {
        if (ack.ok) ok++;
        if (--left === 0) resolve(ok);
      });
    }
  });
}

/** Bots of the current session: added as players, answer each question once it is open. */
export class Rehearsal {
  private settings: BotSettings | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly pending = new Set<() => void>();
  /** Opening already answered; reset whenever answers close, so an undo + re-open is answered again. */
  private handled: string | null = null;
  private runtime: SessionRuntime | null = null;
  private readonly timers: Timers;
  private readonly rand: Rand;

  constructor(timers: Timers, rand: Rand = Math.random) {
    this.timers = timers;
    this.rand = rand;
  }

  get status(): { running: boolean; settings: BotSettings | null; bots: number } {
    const bots = this.runtime?.current.state.participants.filter((p) => isBot(p.id)).length ?? 0;
    return { running: this.settings !== null, settings: this.settings, bots };
  }

  /**
   * Adds missing bots (up to the format maximum, one group commit) and starts answering.
   * Refused when real players are in the session (rehearsal must never pollute a show) unless `withPlayers`.
   */
  async start(runtime: SessionRuntime, settings: BotSettings, withPlayers = false): Promise<{ ok: true; bots: number; refused: number } | { ok: false; error: string }> {
    const humans = runtime.current.state.participants.filter((p) => !isBot(p.id)).length;
    if (humans > 0 && !withPlayers) return { ok: false, error: `${humans} vrai(s) joueur(s) dans la partie : la répétition se fait sur une partie sans joueurs` };
    this.halt();
    this.runtime = runtime;
    this.settings = settings;
    const present = new Set(runtime.current.state.participants.map((p) => p.id));
    const adds: Action[] = [];
    for (let i = 1; i <= settings.bots; i++) {
      const participantId = `${BOT_PREFIX}${i}`;
      if (!present.has(participantId)) adds.push({ type: "player.add", participantId, displayName: `Bot ${i}`, channel: "play" });
    }
    const added = await enqueueAll(runtime, adds);
    if (this.runtime !== runtime) return { ok: false, error: "partie changée pendant le démarrage" };
    this.unsubscribe = runtime.subscribe({ viewer: { role: "control" }, update: (frame) => this.onChange(frame.view) });
    this.onChange(runtime.view({ role: "control" }));
    return { ok: true, bots: this.status.bots, refused: adds.length - added };
  }

  /** Stops answering (pending answers cancelled). Session switch: the bots stay in the old session. */
  halt(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const cancel of this.pending) cancel();
    this.pending.clear();
    this.settings = null;
    this.handled = null;
  }

  /** Stops answering and removes the bots, their points with them (one group commit). */
  async stop(): Promise<number> {
    this.halt();
    const rt = this.runtime;
    if (rt === null) return 0;
    const removes: Action[] = rt.current.state.participants.filter((p) => isBot(p.id)).map((p) => ({ type: "player.remove", participantId: p.id }));
    return enqueueAll(rt, removes);
  }

  /** Session switch: forget the old runtime without touching it. */
  detach(): void {
    this.halt();
    this.runtime = null;
  }

  private onChange(v: View): void {
    const rt = this.runtime;
    const settings = this.settings;
    if (rt === null || settings === null || v.role !== "control") return;
    if (v.phase !== "open" || v.question === null || v.mechanic === null) {
      this.handled = null;
      return;
    }
    const opening = `${v.round?.index ?? 0}:${v.question.index}:${v.question.id}`;
    if (this.handled === opening) return;
    this.handled = opening;
    // One mechanic view for every bot of this opening (never a full projection per bot).
    const mechanic = v.mechanic;
    for (const p of v.participants) {
      if (!isBot(p.id) || p.status !== "active") continue;
      const delay = Math.round(settings.latencyMs * (0.3 + this.rand() * 1.4));
      const action = botAction(mechanic, p.id, this.rand, settings.accuracy);
      if (action === null) continue;
      const cancel = this.timers.set(() => {
        this.pending.delete(cancel);
        if (this.handled === opening) rt.enqueue(action, { role: "player", id: p.id }, null, () => undefined);
      }, delay);
      this.pending.add(cancel);
    }
  }
}
