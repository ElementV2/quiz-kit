import { PLAYER_LEADERBOARD_ROWS, type BaseView, type ControlView, type HostView, type LeaderboardRow, type OutputView, type PlayerView, type TeamLeaderboardRow, type View, type Viewer } from "@quiz/schema";
import type { Game } from "./game.ts";
import type { Audience, Judgement, Registry } from "./mechanic.ts";
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
      return { role: "host", ...base(s, "host", null, registry), notes: currentQuestion(s)?.notes ?? null, nextQuestion: next(s) } satisfies HostView;
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
        ? { id: q.id, index: s.questionIndex, count: round.questions.length, prompt: q.prompt }
        : null,
    timer: s.timer === null ? null : { endsAt: s.timer.endsAt, durationMs: s.timer.durationMs },
    mechanic: m === null || s.mechanic === null ? null : m.project(s.mechanic.state, { audience, phase: s.phase, participantId }),
    // Players get the top only: a full 500-row board in every tablet view would make each broadcast O(n²).
    leaderboard: audience === "player" ? leaderboard(s).slice(0, PLAYER_LEADERBOARD_ROWS) : leaderboard(s),
    teamBoard: teamBoard(s),
  };
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
    myResult = resultOf(m.judge(s.mechanic.state), me.id, me.teamId);
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

/** A player's result: any correct judgement concerning them (or their team) wins over wrong ones. */
function resultOf(judgements: readonly Judgement[], participantId: string, teamId: string | null): PlayerView["myResult"] {
  let result: PlayerView["myResult"] = "none";
  for (const j of judgements) {
    const mine = j.kind === "rule" ? j.participantId === participantId : "participantId" in j.target ? j.target.participantId === participantId : j.target.teamId === teamId;
    if (!mine) continue;
    if (j.outcome === "correct") return "correct";
    result = "wrong";
  }
  return result;
}

function controlView(game: Game, readonly: boolean, registry: Registry): ControlView {
  const s = game.state;
  const m = s.mechanic === null ? null : registry.get(s.mechanic.id);
  return {
    role: "control",
    ...base(s, "control", null, registry),
    readonly,
    notes: currentQuestion(s)?.notes ?? null,
    nextQuestion: next(s),
    participants: s.participants,
    teams: s.teams,
    ledger: s.ledger,
    answers: m === null || s.mechanic === null ? [] : m.answers(s.mechanic.state).map((x) => ({ ...x, optionIds: [...x.optionIds] })),
    skipped: [...game.skipped],
    lastSeq: s.lastSeq,
  };
}

function next(s: GameState): HostView["nextQuestion"] {
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

function computeLeaderboard(s: GameState): LeaderboardRow[] {
  const rows = s.participants
    .map((p, order) => ({ p, order, total: participantTotal(s, p.id) }))
    .toSorted((a, b) => b.total - a.total || a.order - b.order);
  let rank = 0;
  let prev: number | null = null;
  return rows.map((r, i) => {
    if (r.total !== prev) rank = i + 1;
    prev = r.total;
    return { participantId: r.p.id, displayName: r.p.displayName, teamId: r.p.teamId, total: r.total, rank };
  });
}
