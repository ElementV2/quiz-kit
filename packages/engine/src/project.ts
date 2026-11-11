import { PLAYER_LEADERBOARD_ROWS, type BaseView, type ControlView, type HostView, type LeaderboardRow, type OutputView, type Rundown, type PlayerView, type TeamLeaderboardRow, type View, type Viewer } from "@quiz/schema";
import type { Game } from "./game.ts";
import type { AnyMechanic, Audience, Registry } from "./mechanic.ts";
import { assertNever } from "./result.ts";
import { currentQuestion, currentRound, nextQuestion, participantTotal, teamTotal, type GameState } from "./state.ts";

/**
 * Role-filtered view (ADR-0004). The only way state leaves the server.
 * Player / output views never contain: correct answers before reveal, host notes, other players' answers.
 */
export function project(game: Game, viewer: Viewer, registry: Registry): View {
  const s = game.state;
  switch (viewer.role) {
    case "output":
      return { role: "output", ...base(s, "public", null, registry) } satisfies OutputView;
    case "player":
      return playerView(s, viewer.participantId, registry);
    case "seat": {
      const p = s.participants.find((x) => x.seat === viewer.seat);
      return playerView(s, p?.id ?? null, registry);
    }
    case "host":
      return {
        role: "host",
        ...base(s, "host", null, registry),
        notes: currentQuestion(s)?.notes ?? null,
        nextQuestion: next(s, registry),
        drive: s.hostDrives,
        rundown: rundownOf(s),
        cursor: s.roundIndex === null ? null : { roundIndex: s.roundIndex, questionIndex: s.questionIndex },
      } satisfies HostView;
    case "control":
    case "control-readonly":
    case "scorer":
    case "studio":
      return controlView(game, viewer.role !== "control" && viewer.role !== "scorer", registry);
    default:
      return assertNever(viewer);
  }
}

function base(s: GameState, audience: Audience, participantId: string | null, registry: Registry): BaseView {
  const round = currentRound(s);
  const q = currentQuestion(s);
  const showQuestion = q !== null && s.mechanic !== null;
  const m = s.mechanic === null ? null : registry.get(s.mechanic.id);
  return {
    sessionId: s.sessionId,
    phase: s.phase,
    round: round === null || s.roundIndex === null ? null : { index: s.roundIndex, count: s.game.format.rounds.length, title: round.title },
    question:
      showQuestion && round !== null && s.questionIndex !== null
        ? { id: q.id, index: s.questionIndex, count: round.questions.length, prompt: audience === "player" && m?.hidesPromptMedia === true ? { text: q.prompt.text } : q.prompt }
        : null,
    timer: s.timer === null ? null : { endsAt: s.timer.endsAt, durationMs: s.timer.durationMs },
    mechanic: m === null || s.mechanic === null ? idleMechanic(s, audience, participantId, registry) : m.project(s.mechanic.state, { audience, phase: s.phase, participantId }),
    // Players get the top only: a full 500-row board in every tablet view would make each broadcast O(n²).
    leaderboard: audience === "player" ? leaderboard(s).slice(0, PLAYER_LEADERBOARD_ROWS) : leaderboard(s),
    layers: s.layers,
    teamBoard: teamBoard(s),
  };
}

/** Between two questions of a round whose mechanic shows something meanwhile (board grid). */
/** Idle views per (round, carried state, audience): computed once, shared by the 500 tablets. */
const idleCache = new WeakMap<object, WeakMap<object, Map<Audience, BaseView["mechanic"]>>>();
const NO_CARRY = {};

function idleMechanic(s: GameState, audience: Audience, participantId: string | null, registry: Registry): BaseView["mechanic"] {
  const round = currentRound(s);
  if (s.phase !== "idle" || round === null) return null;
  const m = registry.get(round.mechanic);
  if (m?.projectIdle === undefined) return null;
  const previous = s.carry !== null && s.carry.id === m.id ? s.carry.state : null;
  const carryKey = typeof previous === "object" && previous !== null ? previous : NO_CARRY;
  let byCarry = idleCache.get(round);
  if (byCarry === undefined) {
    byCarry = new WeakMap();
    idleCache.set(round, byCarry);
  }
  let byAudience = byCarry.get(carryKey);
  if (byAudience === undefined) {
    byAudience = new Map();
    byCarry.set(carryKey, byAudience);
  }
  if (byAudience.has(audience)) return byAudience.get(audience) ?? null;
  const cfg = m.configSchema.safeParse(round.mechanicConfig);
  if (!cfg.success) return null;
  const byId = new Map(s.game.questions.map((q) => [q.id, q]));
  const questions = round.questions.flatMap((id) => {
    const q = byId.get(id);
    return q === undefined ? [] : [q];
  });
  const v = m.projectIdle(cfg.data, questions, previous, { audience, phase: s.phase, participantId });
  byAudience.set(audience, v);
  return v;
}

/** Memoised per (ledger, teams) identity like the player leaderboard. Teams are few: sent to everyone. */
const teamBoardCache = new WeakMap<object, WeakMap<object, TeamLeaderboardRow[]>>();

export function teamBoard(s: GameState): TeamLeaderboardRow[] {
  let inner = teamBoardCache.get(s.ledger);
  if (inner === undefined) {
    inner = new WeakMap();
    teamBoardCache.set(s.ledger, inner);
  }
  const cached = inner.get(s.teams);
  if (cached !== undefined) return cached;
  const rows = s.teams.map((t, order) => ({ t, order, total: teamTotal(s, t.id) })).toSorted((a, b) => b.total - a.total || a.order - b.order);
  let rank = 0;
  let prev: number | null = null;
  const board = rows.map((r, i) => {
    if (r.total !== prev) rank = i + 1;
    prev = r.total;
    return { teamId: r.t.id, name: r.t.name, color: r.t.color, total: r.total, rank };
  });
  inner.set(s.teams, board);
  return board;
}

function playerView(s: GameState, participantId: string | null, registry: Registry): PlayerView {
  const me = participantId === null ? undefined : s.participants.find((p) => p.id === participantId);
  const m = s.mechanic === null ? null : registry.get(s.mechanic.id);
  const myAnswer = me === undefined || m === null || s.mechanic === null ? null : m.answerOf(s.mechanic.state, me.id);
  let myResult: PlayerView["myResult"] = null;
  if (s.phase === "revealed" && me !== undefined && m !== null && s.mechanic !== null) {
    myResult = resultsOf(m, s.mechanic.state).of(me.id, me.teamId);
  }
  return {
    role: "player",
    ...base(s, "player", me?.id ?? null, registry),
    me: me === undefined ? null : { participantId: me.id, displayName: me.displayName, status: me.status, teamId: me.teamId, total: participantTotal(s, me.id), rank: rankOf(s, me.id) },
    myAnswer: myAnswer === null ? null : [...myAnswer],
    myResult,
    canAnswer: s.phase === "open" && me !== undefined && me.status === "active",
  };
}

/** Any correct judgement wins over wrong ones. */
function mark(map: Map<string, "correct" | "wrong">, id: string, outcome: "correct" | "wrong"): void {
  if (map.get(id) !== "correct") map.set(id, outcome);
}

type Results = { of(participantId: string, teamId: string | null): PlayerView["myResult"] };
/** judge() once per mechanic state, then an O(1) lookup per player (500 tablets: no O(n²) per broadcast). */
const resultsCache = new WeakMap<object, Results>();

function resultsOf(m: AnyMechanic, state: unknown): Results {
  const key = typeof state === "object" && state !== null ? state : null;
  const cached = key === null ? undefined : resultsCache.get(key);
  if (cached !== undefined) return cached;
  const byPlayer = new Map<string, "correct" | "wrong">();
  const byTeam = new Map<string, "correct" | "wrong">();
  for (const j of m.judge(state)) {
    if (j.kind === "rule") mark(byPlayer, j.participantId, j.outcome);
    else if ("participantId" in j.target) mark(byPlayer, j.target.participantId, j.outcome);
    else mark(byTeam, j.target.teamId, j.outcome);
  }
  const r: Results = {
    of(participantId, teamId) {
      const own = byPlayer.get(participantId);
      const team = teamId === null ? undefined : byTeam.get(teamId);
      return own === "correct" || team === "correct" ? "correct" : (own ?? team ?? "none");
    },
  };
  if (key !== null) resultsCache.set(key, r);
  return r;
}

function controlView(game: Game, readonly: boolean, registry: Registry): ControlView {
  const s = game.state;
  const m = s.mechanic === null ? null : registry.get(s.mechanic.id);
  return {
    role: "control",
    ...base(s, "control", null, registry),
    readonly,
    hostDrives: s.hostDrives,
    notes: currentQuestion(s)?.notes ?? null,
    nextQuestion: next(s, registry),
    participants: s.participants,
    teams: s.teams,
    ledger: s.ledger,
    answers: m === null || s.mechanic === null ? [] : m.answers(s.mechanic.state).map((x) => ({ ...x, optionIds: [...x.optionIds] })),
    skipped: [...game.skipped],
    rundown: rundownOf(s),
    lastSeq: s.lastSeq,
  };
}

/** Run-down memoised per game document (it only changes with reserve swaps / edits / regrades). */
const rundownCache = new WeakMap<object, WeakMap<object, Rundown>>();

function rundownOf(s: GameState): Rundown {
  let inner = rundownCache.get(s.game);
  if (inner === undefined) {
    inner = new WeakMap();
    rundownCache.set(s.game, inner);
  }
  const cached = inner.get(s.played);
  if (cached !== undefined) return cached;
  const byId = new Map(s.game.questions.map((q) => [q.id, q]));
  const r: Rundown = s.game.format.rounds.map((round, index) => ({
    index,
    title: round.title,
    mechanic: round.mechanic,
    questions: round.questions.flatMap((qid, qi) => {
      const q = byId.get(qid);
      return q === undefined ? [] : [{ index: qi, id: qid, text: q.prompt.text, played: s.played.includes(qid), answerSpec: q.answerSpec, notes: q.notes ?? null }];
    }),
    reserve: round.reserve.flatMap((qid) => {
      const q = byId.get(qid);
      return q === undefined ? [] : [{ id: qid, text: q.prompt.text }];
    }),
  }));
  inner.set(s.played, r);
  return r;
}

function next(s: GameState, registry: Registry): HostView["nextQuestion"] {
  const round = currentRound(s);
  // Free order (board): control picks the next cell, there is no "next question".
  if (round !== null && registry.get(round.mechanic)?.freeOrder === true) return null;
  const q = nextQuestion(s);
  return q === null ? null : { id: q.id, text: q.prompt.text };
}

/** Memoised per (ledger, participants) identity: computed once per state, shared by every projection (ADR-0004). */
const boardCache = new WeakMap<object, WeakMap<object, LeaderboardRow[]>>();

const rankCache = new WeakMap<readonly LeaderboardRow[], ReadonlyMap<string, number>>();

function rankOf(s: GameState, participantId: string): number {
  const board = leaderboard(s);
  let ranks = rankCache.get(board);
  if (ranks === undefined) {
    ranks = new Map(board.map((r) => [r.participantId, r.rank]));
    rankCache.set(board, ranks);
  }
  return ranks.get(participantId) ?? s.participants.length;
}

/** Standard competition ranking (1, 1, 3); ties keep registration order. */
export function leaderboard(s: GameState): LeaderboardRow[] {
  let inner = boardCache.get(s.ledger);
  if (inner === undefined) {
    inner = new WeakMap();
    boardCache.set(s.ledger, inner);
  }
  const cached = inner.get(s.participants);
  if (cached !== undefined) return cached;
  const board = computeLeaderboard(s);
  inner.set(s.participants, board);
  return board;
}

/** Right answers and their cumulated response time per player (format `tieBreak: speed`). */
export function speedTotals(s: GameState): ReadonlyMap<string, { readonly right: number; readonly ms: number }> {
  const out = new Map<string, { right: number; ms: number }>();
  for (const h of s.history) {
    for (const c of h.correctMs) {
      const t = out.get(c.participantId) ?? { right: 0, ms: 0 };
      out.set(c.participantId, { right: t.right + 1, ms: t.ms + c.ms });
    }
  }
  return out;
}

/**
 * Same total → same rank (1, 1, 3) with `tieBreak: control` (the control room decides: barrage round or manual
 * points). With `speed`, equal totals are split by the number of right answers (more first), then by their
 * cumulated response time (faster first). Display order of exact ties: registration order.
 */
function computeLeaderboard(s: GameState): LeaderboardRow[] {
  const speed = s.game.format.tieBreak === "speed" ? speedTotals(s) : null;
  const right = (id: string): number => (speed === null ? 0 : (speed.get(id)?.right ?? 0));
  const ms = (id: string): number => (speed === null ? 0 : (speed.get(id)?.ms ?? 0));
  const rows = s.participants
    .map((p, order) => ({ p, order, total: participantTotal(s, p.id), right: right(p.id), ms: ms(p.id) }))
    .toSorted((a, b) => b.total - a.total || b.right - a.right || a.ms - b.ms || a.order - b.order);
  let rank = 0;
  let prev: { total: number; right: number; ms: number } | null = null;
  return rows.map((r, i) => {
    if (prev === null || r.total !== prev.total || r.right !== prev.right || r.ms !== prev.ms) rank = i + 1;
    prev = { total: r.total, right: r.right, ms: r.ms };
    return { participantId: r.p.id, displayName: r.p.displayName, teamId: r.p.teamId, total: r.total, rank };
  });
}
