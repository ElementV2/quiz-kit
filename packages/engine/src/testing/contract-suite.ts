import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { View, type Action, type Actor, type GameDocument, type Viewer } from "@quiz/schema";
import { createGame, decide, replay, type Game } from "../game.ts";
import type { AnyMechanic, Registry } from "../mechanic.ts";
import { project } from "../project.ts";
import { assertNever } from "../result.ts";
import { participantTotal } from "../state.ts";
import { actor, CONTROL, deepFreeze, makeSession } from "./harness.ts";

export type ContractOptions = {
  readonly mechanic: AnyMechanic;
  readonly registry: Registry;
  /** A game whose rounds all use `mechanic`. Questions should carry `notes` to test the no-leak rule. */
  readonly game: GameDocument;
  /** Builds a candidate answer from the current mechanic view and random numbers. */
  readonly answerFor: (view: View, picks: readonly number[]) => Action | null;
};

const PLAYERS = ["p_1", "p_2", "p_3"] as const;

type Flow = "game.start" | "round.start" | "question.present" | "question.open" | "question.lock" | "question.reveal" | "question.next";

type Cmd =
  | { readonly k: "advance" }
  | { readonly k: "flow"; readonly type: Flow }
  | { readonly k: "answer"; readonly player: number; readonly picks: readonly number[] }
  | { readonly k: "expire" }
  | { readonly k: "adjust"; readonly player: number; readonly delta: number }
  | { readonly k: "void"; readonly pick: number }
  | { readonly k: "undo" }
  | { readonly k: "undoAt"; readonly pick: number }
  | { readonly k: "remove"; readonly player: number }
  | { readonly k: "readd"; readonly player: number }
  | { readonly k: "status"; readonly player: number; readonly status: "active" | "eliminated" }
  | { readonly k: "team"; readonly player: number; readonly team: number }
  | { readonly k: "timerSet"; readonly ms: number };

const FLOWS: readonly Flow[] = ["game.start", "round.start", "question.present", "question.open", "question.lock", "question.reveal", "question.next"];

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 14, arbitrary: fc.constant({ k: "advance" } as const) },
  { weight: 2, arbitrary: fc.constantFrom(...FLOWS).map((type) => ({ k: "flow", type }) as const) },
  { weight: 8, arbitrary: fc.record({ k: fc.constant("answer" as const), player: fc.nat(PLAYERS.length - 1), picks: fc.array(fc.nat(), { minLength: 1, maxLength: 4 }) }) },
  { weight: 1, arbitrary: fc.constant({ k: "expire" } as const) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("adjust" as const), player: fc.nat(PLAYERS.length - 1), delta: fc.integer({ min: -50, max: 50 }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("void" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ k: "undo" } as const) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("undoAt" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("remove" as const), player: fc.nat(PLAYERS.length - 1) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("readd" as const), player: fc.nat(PLAYERS.length - 1) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("status" as const), player: fc.nat(PLAYERS.length - 1), status: fc.constantFrom("active" as const, "eliminated" as const) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("team" as const), player: fc.nat(PLAYERS.length - 1), team: fc.nat(2) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("timerSet" as const), ms: fc.integer({ min: 0, max: 30_000 }) }) },
);

const TEAMS = ["t_a", "t_b"] as const;

/** The valid next flow action for the current phase (drives games forward so properties cover reveals). */
function nextFlow(g: Game): Flow | null {
  switch (g.state.phase) {
    case "lobby":
      return "game.start";
    case "idle":
      return g.state.roundIndex === null ? "round.start" : "question.present";
    case "round.end":
      return "round.start";
    case "presenting":
      return "question.open";
    case "open":
      return "question.lock";
    case "locked":
    case "judging":
      return "question.reveal";
    case "revealed":
      return "question.next";
    case "game.end":
      return null;
    default:
      return assertNever(g.state.phase);
  }
}

const VIEWERS: readonly Viewer[] = [
  { role: "output", scene: "program" },
  { role: "player", participantId: "p_1" },
  { role: "seat", seat: 2 },
  { role: "host" },
  { role: "control" },
  { role: "control-readonly" },
  { role: "scorer" },
  { role: "studio" },
];

function toIntent(g: Game, cmd: Cmd, opts: ContractOptions): { action: Action; actor: Actor } | null {
  switch (cmd.k) {
    case "advance": {
      const type = nextFlow(g);
      return type === null ? null : { action: { type }, actor: CONTROL };
    }
    case "flow":
      return { action: { type: cmd.type }, actor: CONTROL };
    case "answer": {
      const pid = PLAYERS[cmd.player] ?? "p_1";
      const a = opts.answerFor(project(g, { role: "player", participantId: pid }, opts.registry), cmd.picks);
      return a === null ? null : { action: a.type === "answer.submit" ? { ...a, participantId: pid } : a, actor: actor("player", pid) };
    }
    case "expire":
      return g.state.timer === null ? null : { action: { type: "timer.expired", timerId: g.state.timer.id }, actor: actor("system") };
    case "adjust":
      return cmd.delta === 0 ? null : { action: { type: "score.adjust", target: { participantId: PLAYERS[cmd.player] ?? "p_1" }, delta: cmd.delta, reason: "manual" }, actor: CONTROL };
    case "void": {
      const e = g.state.ledger[cmd.pick % Math.max(g.state.ledger.length, 1)];
      return e === undefined ? null : { action: { type: "score.void", entryId: e.id }, actor: CONTROL };
    }
    case "undo":
      return { action: { type: "undo" }, actor: CONTROL };
    case "undoAt": {
      const e = g.events[cmd.pick % Math.max(g.events.length, 1)];
      return e === undefined ? null : { action: { type: "undo", targetSeq: e.seq }, actor: CONTROL };
    }
    case "remove":
      return { action: { type: "player.remove", participantId: PLAYERS[cmd.player] ?? "p_1" }, actor: CONTROL };
    case "readd": {
      const pid = PLAYERS[cmd.player] ?? "p_1";
      return { action: { type: "player.add", participantId: pid, displayName: `R${cmd.player}`, channel: "seat" }, actor: CONTROL };
    }
    case "status":
      return { action: { type: "player.setStatus", participantId: PLAYERS[cmd.player] ?? "p_1", status: cmd.status }, actor: CONTROL };
    case "team":
      return { action: { type: "player.setTeam", participantId: PLAYERS[cmd.player] ?? "p_1", teamId: TEAMS[cmd.team] ?? null }, actor: CONTROL };
    case "timerSet":
      return { action: { type: "timer.set", remainingMs: cmd.ms }, actor: CONTROL };
    default:
      return assertNever(cmd);
  }
}

function checkInvariants(g: Game, opts: ContractOptions): void {
  const s = g.state;
  const notes = s.game.questions.flatMap((q) => (q.notes === undefined ? [] : [q.notes]));
  for (const viewer of VIEWERS) {
    const v = project(g, viewer, opts.registry);
    // Views honour the shared contract (strict schemas: no extra field can sneak in).
    View.parse(v);
    if (v.role === "player" || v.role === "output") {
      const json = JSON.stringify(v);
      for (const n of notes) expect(json, "host notes leaked").not.toContain(n);
      expect(json, "other players' answers leaked").not.toContain('"answers"');
      expect(json, "ledger leaked").not.toContain('"ledger"');
      if (s.phase !== "revealed") {
        expect(v.mechanic?.correct ?? null, `correct answer leaked to ${v.role} in ${s.phase}`).toBeNull();
        expect(v.mechanic?.counts ?? null, `distribution leaked to ${v.role} in ${s.phase}`).toBeNull();
      }
    }
  }
  for (const row of project(g, { role: "output", scene: "program" }, opts.registry).leaderboard) {
    expect(row.total, "leaderboard total differs from ledger").toBe(participantTotal(s, row.participantId));
  }
}

export type Coverage = { reveals: number; autoScores: number; undos: number; skipped: number };

function setup(opts: ContractOptions): Game {
  let g = createGame(makeSession(opts.game, 7));
  let at = 1_000;
  const steps: Action[] = [
    ...TEAMS.map((t): Action => ({ type: "team.add", teamId: t, name: t, color: "#123456" })),
    ...PLAYERS.map((pid, i): Action => ({ type: "player.add", participantId: pid, displayName: `J${i + 1}`, seat: i + 1, channel: "seat" })),
  ];
  for (const action of steps) {
    const r = decide(g, { action, actor: CONTROL, idempotencyKey: null }, (at += 1000), opts.registry);
    if (!r.ok) throw new Error(r.error.message);
    g = r.value.game;
  }
  return g;
}

/** Runs the contract property; throws on the first violated invariant. Returns what was exercised. */
export function assertContract(opts: ContractOptions, numRuns = 200): Coverage {
  const cov: Coverage = { reveals: 0, autoScores: 0, undos: 0, skipped: 0 };
  fc.assert(
    fc.property(fc.array(cmdArb, { minLength: 20, maxLength: 150, size: "max" }), (cmds) => {
      let g = setup(opts);
      let at = 100_000;
      for (const cmd of cmds) {
        at += 1500;
        const intent = toIntent(g, cmd, opts);
        if (intent === null) continue;
        deepFreeze(g); // any mutation by the engine throws
        const r = decide(g, { ...intent, idempotencyKey: null }, at, opts.registry);
        if (!r.ok) continue;
        const before = g.state.ledger.length;
        g = r.value.game;
        if (intent.action.type === "question.reveal") {
          cov.reveals++;
          cov.autoScores += g.state.ledger.length - before;
        }
        if (intent.action.type === "undo") cov.undos++;
        checkInvariants(g, opts);
      }
      cov.skipped += g.skipped.length;
      const replayed = replay(g.session, g.events, opts.registry);
      expect(replayed.state, "replay differs from live state").toEqual(g.state);
    }),
    { numRuns },
  );
  return cov;
}

/** Contract every mechanic must pass (doc 03, CONVENTIONS "L — substitution"). */
export function mechanicContractSuite(opts: ContractOptions): void {
  describe(`mechanic contract: ${opts.mechanic.id}`, () => {
    it("rejects answers outside the open phase", () => {
      const g = setup(opts);
      const a = opts.answerFor(project(g, { role: "control" }, opts.registry), [0]);
      const action: Action = a ?? { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["a"] } };
      expect(decide(g, { action, actor: actor("player", "p_1"), idempotencyKey: null }, 99_000, opts.registry).ok).toBe(false);
    });

    it("never leaks, never mutates, replays identically, keeps totals = ledger", () => {
      const cov = assertContract(opts);
      // The property must actually exercise reveals, scoring and undo — otherwise it proves nothing.
      expect(cov.reveals).toBeGreaterThan(50);
      expect(cov.autoScores).toBeGreaterThan(20);
      expect(cov.undos).toBeGreaterThan(20);
      expect(cov.skipped).toBeGreaterThan(0);
    });
  });
}
