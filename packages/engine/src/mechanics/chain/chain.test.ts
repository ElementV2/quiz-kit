import { describe, expect, it } from "vitest";
import { DEMO_CHAIN_GAME, type Action, type ChainMechanicView, type ControlView, type GameDocument, type View, type Viewer } from "@quiz/schema";
import { createGame, decide, replay, type Game } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { GameState, participantTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, addPlayers, ctl, makeSession, run, type Step } from "../../testing/harness.ts";
import { chain, ChainConfig } from "./chain.ts";

const chainOf = (v: View): ChainMechanicView | null => (v.mechanic?.mechanic === "chain" ? v.mechanic : null);

// ---------------------------------------------------------------------------------------------
// Contract suite: the generator plays like the control room (judges, banks, ends rounds, runs the
// vote) and like the players (bank on their turn, vote, pick on a tie).
// ---------------------------------------------------------------------------------------------

function answerFor(_view: View, picks: readonly number[], participantId: string, control: ControlView): Action | null {
  const m = chainOf(control);
  if (m === null) return null;
  const [p0 = 0, p1 = 0] = picks;
  const others = (m.vote?.voters ?? m.order).filter((id) => id !== participantId);
  const against = others[p1 % Math.max(others.length, 1)] ?? participantId;
  // One time in eight: any chain action, valid or not (exercises rejections).
  if (p0 % 8 === 0) {
    const all: Action[] = [
      { type: "chain.bank", participantId },
      { type: "chain.vote", participantId, against: p1 % 3 === 0 ? participantId : against },
      { type: "chain.pick", participantId, eliminated: against },
    ];
    return all[p1 % all.length] ?? null;
  }
  if (m.vote?.status === "open") return { type: "chain.vote", participantId, against };
  if (m.vote?.status === "tie" && m.vote.picker === participantId) {
    const tied = m.vote.tied.filter((id) => id !== participantId);
    return { type: "chain.pick", participantId, eliminated: tied[p1 % Math.max(tied.length, 1)] ?? participantId };
  }
  if (m.turn === participantId && m.chainValue > 0 && control.question !== null) return { type: "chain.bank", participantId };
  return null;
}

function controlActionFor(control: ControlView, picks: readonly number[]): Action | null {
  const m = chainOf(control);
  const [p0 = 0, p1 = 0] = picks;
  if (m === null) return { type: "answer.judge", correct: true };
  if (control.question !== null && control.phase !== "revealed") {
    if (p0 % 12 === 1 && m.stage === "chain" && m.bank > 0) return { type: "chain.end" }; // time is up, after some banking
    if (p0 % 6 === 0 && m.turn !== null && m.chainValue > 0) return { type: "chain.bank", participantId: m.turn };
    return { type: "answer.judge", correct: p1 % 10 < (m.stage === "duel" ? 5 : 9) };
  }
  if (control.question !== null) return null;
  const v = m.vote;
  const active = control.participants.filter((p) => p.status === "active");
  if (v?.status === "open") {
    if (v.cast >= v.voters.length - 1 || p0 % 8 === 0) return { type: "chain.closeVote" };
    if (p0 % 3 !== 0) return null; // the players vote
    const voter = v.voters[p1 % v.voters.length] ?? "p_1";
    return { type: "chain.vote", participantId: voter, against: v.voters.find((id) => id !== voter) ?? voter };
  }
  if (v?.status === "tie") {
    const picker = v.picker ?? "p_1";
    return { type: "chain.pick", participantId: picker, eliminated: v.tied.find((id) => id !== picker) ?? picker };
  }
  // A duel needs its two players active: like the control room would, fix the statuses by hand (the vote also gets there).
  const pair = m.stage === "duel" && m.order.length === 2 ? m.order : null;
  // A duel player was removed: that duel cannot go on, the control room moves to the next round.
  const broken = m.stage === "duel" && m.order.length < 2 && m.duel?.winner === null;
  if (control.phase === "idle" && broken && control.round !== null && control.round.index + 1 < control.round.count) return { type: "round.start", roundIndex: control.round.index + 1 };
  if (control.phase === "idle" && pair !== null) {
    const wrong = control.participants.find((p) => (p.status === "active") !== pair.includes(p.id));
    if (wrong !== undefined) return { type: "player.setStatus", participantId: wrong.id, status: wrong.status === "active" ? "eliminated" : "active" };
  }
  const duelWaiting = control.phase === "idle" && control.round?.title === "Duel final" && active.length !== 2;
  if (v === null && m.stage === "chain" && active.length >= 3 && (!duelWaiting || p0 % 4 !== 0)) return { type: "chain.openVote" };
  if (duelWaiting) {
    const p = active.length > 2 ? active[p1 % active.length] : control.participants.find((x) => x.status !== "active");
    if (p !== undefined) return { type: "player.setStatus", participantId: p.id, status: active.length > 2 ? "eliminated" : "active" };
  }
  return p0 % 6 === 0 ? { type: "chain.end" } : { type: "chain.openVote" };
}

function assertNoLeak(view: View, control: ControlView): void {
  const m = chainOf(view);
  const truth = chainOf(control);
  if (m === null || truth === null) return;
  if (view.phase !== "revealed") expect(m.expected, `expected answer leaked to ${view.role} in ${view.phase}`).toBeNull();
  if (m.vote !== null && m.vote.status === "open") {
    expect(m.vote.ballots, `ballots leaked to ${view.role}`).toBeNull();
    expect(m.vote.tally, `tally leaked to ${view.role}`).toBeNull();
  }
  if (view.role === "output") expect(m.vote?.myVote ?? null).toBeNull();
}

/**
 * Three times a short chain round then a short duel (1 question each + sudden death). The first chain is two questions
 * on one step (a right answer fills the bank): duels with a pot are reached often within a property run.
 */
const CONTRACT_CHAINS = [{ stage: "chain", steps: [10] }, { stage: "chain", steps: [10, 20] }, { stage: "chain", steps: [10, 20, 40], bankTarget: 50 }];

const CONTRACT_GAME: GameDocument = (() => {
  const [c1, , duel] = DEMO_CHAIN_GAME.format.rounds;
  if (c1 === undefined || duel === undefined) throw new Error("DEMO_CHAIN_GAME has 3 rounds");
  return {
    ...DEMO_CHAIN_GAME,
    format: {
      ...DEMO_CHAIN_GAME.format,
      participants: { max: 10 },
      rounds: [0, 1, 2].flatMap((i) => [
        { ...c1, id: `r_c_${i}`, questions: c1.questions.slice(i, i === 0 ? 3 : i + 3), mechanicConfig: CONTRACT_CHAINS[i] },
        { ...duel, id: `r_d_${i}`, questions: duel.questions.slice(i, i + 9), mechanicConfig: { stage: "duel", questionsEach: 1 } },
      ]),
    },
  };
})();

mechanicContractSuite({ mechanic: chain, registry: reg, game: CONTRACT_GAME, answerFor, controlActionFor, assertNoLeak });

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

type RoundPatch = { readonly steps?: readonly number[]; readonly bankTarget?: number; readonly questions?: readonly string[] };

/** The demo game, its chain rounds adjusted (index → patch). */
function withRounds(patches: Readonly<Record<number, RoundPatch>>): GameDocument {
  return {
    ...DEMO_CHAIN_GAME,
    format: {
      ...DEMO_CHAIN_GAME.format,
      rounds: DEMO_CHAIN_GAME.format.rounds.map((r, i) => {
        const p = patches[i];
        if (p === undefined) return r;
        const base = typeof r.mechanicConfig === "object" && r.mechanicConfig !== null ? r.mechanicConfig : {};
        const cfg = { ...base, ...(p.steps === undefined ? {} : { steps: p.steps }), ...(p.bankTarget === undefined ? {} : { bankTarget: p.bankTarget }) };
        return { ...r, mechanicConfig: cfg, ...(p.questions === undefined ? {} : { questions: [...p.questions] }) };
      }),
    },
  };
}

const START: Step[] = [...addPlayers(4), ctl({ type: "game.start" }), ctl({ type: "round.start" })];
const PRESENT = ctl({ type: "question.present" });
const NEXT = ctl({ type: "question.next" });
const OPEN = ctl({ type: "question.open" });
const LOCK = ctl({ type: "question.lock" });
const REVEAL = ctl({ type: "question.reveal" });
const judge = (correct: boolean): Step => ctl({ type: "answer.judge", correct });
/** One turn: present, judged, next. */
const turn = (correct: boolean): Step[] => [PRESENT, judge(correct), NEXT];
const bank = (pid: string): Step => [actor("player", pid), { type: "chain.bank", participantId: pid }];
const vote = (pid: string, against: string): Step => [actor("player", pid), { type: "chain.vote", participantId: pid, against }];
const OPEN_VOTE = ctl({ type: "chain.openVote" });
const CLOSE_VOTE = ctl({ type: "chain.closeVote" });

const play = (steps: readonly Step[], game: GameDocument = DEMO_CHAIN_GAME): Game => run(reg, steps, createGame(makeSession(game)));
const viewOf = (g: Game, viewer: Viewer = { role: "control" }): ChainMechanicView => {
  const m = chainOf(project(g, viewer, reg));
  if (m === null) throw new Error(`no chain view in phase ${g.state.phase}`);
  return m;
};
const attempt = (g: Game, [who, action]: Step) => decide(g, { action, actor: who, idempotencyKey: null }, 9_000_000 + g.events.length * 1000, reg);
const statusOf = (g: Game, pid: string) => g.state.participants.find((p) => p.id === pid)?.status;

describe("chain settings", () => {
  it("imposes no amounts: a chain round without steps is refused when presented, with a clear message", () => {
    expect(ChainConfig.parse({}).steps).toEqual([]);
    const g = play(START, withRounds({ 0: { steps: [] } }));
    const r = attempt(g, PRESENT);
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringMatching(/aucun montant/) } });
  });

  it("refuses steps that do not increase", () => {
    expect(ChainConfig.safeParse({ steps: [50, 20] }).success).toBe(false);
  });

  it("plays spoken and free-text questions only", () => {
    const qcm = { ...DEMO_CHAIN_GAME, questions: DEMO_CHAIN_GAME.questions.map((q) => (q.id === "q_ch1_1" ? { ...q, answerSpec: { kind: "boolean" as const, correct: true } } : q)) };
    expect(attempt(play(START, qcm), PRESENT).ok).toBe(false);
  });
});

describe("chain turns", () => {
  it("players answer in turn, in a stable order, rotating over the round's questions", () => {
    const g = play([...START, ...turn(true), ...turn(true), ...turn(true), ...turn(true), PRESENT]);
    expect(viewOf(g)).toMatchObject({ order: ["p_1", "p_2", "p_3", "p_4"], turn: "p_1" });
  });

  it("skips a player who is no longer active", () => {
    const g = play([...START, ...turn(true), ctl({ type: "player.setStatus", participantId: "p_2", status: "eliminated" }), PRESENT]);
    expect(viewOf(g).turn).toBe("p_3");
  });

  it("the next turn starts after a removed player's place", () => {
    const g = play([...START, PRESENT, ctl({ type: "player.remove", participantId: "p_1" }), NEXT, PRESENT]);
    expect(viewOf(g)).toMatchObject({ order: ["p_2", "p_3", "p_4"], turn: "p_2" });
  });

  it("a right answer climbs one step, a wrong one drops the chain to 0", () => {
    const up = play([...START, ...turn(true), ...turn(true)]);
    expect(viewOf(up)).toMatchObject({ level: 2, chainValue: 50, bank: 0 });
    const down = run(reg, turn(false), up);
    expect(viewOf(down)).toMatchObject({ level: 0, chainValue: 0, bank: 0 });
    expect(viewOf(down).stats).toEqual([
      { participantId: "p_1", right: 1, wrong: 0, banked: 0 },
      { participantId: "p_2", right: 1, wrong: 0, banked: 0 },
      { participantId: "p_3", right: 0, wrong: 1, banked: 0 },
      { participantId: "p_4", right: 0, wrong: 0, banked: 0 },
    ]);
  });

  it("the player on turn banks before their answer: the chain goes to the bank and restarts", () => {
    const g = play([...START, ...turn(true), ...turn(true), PRESENT, bank("p_3"), judge(true)]);
    expect(viewOf(g)).toMatchObject({ bank: 50, level: 1, chainValue: 20, totalBank: 50, verdict: "right" });
    expect(viewOf(g).stats.find((x) => x.participantId === "p_3")).toEqual({ participantId: "p_3", right: 1, wrong: 0, banked: 50 });
    expect(participantTotal(g.state, "p_3")).toBe(0); // banks are shown, never scored before the final
  });

  it("the host or the control room banks on the player's behalf", () => {
    const g = play([...START, ...turn(true), PRESENT, [actor("host"), { type: "chain.bank", participantId: "p_2" }]]);
    expect(viewOf(g).bank).toBe(20);
  });

  it("refuses a bank from another player, after the answer, or with an empty chain", () => {
    const g = play([...START, ...turn(true), PRESENT]);
    expect(attempt(g, bank("p_3")).ok).toBe(false); // not their turn
    expect(attempt(g, [actor("player", "p_3"), { type: "chain.bank", participantId: "p_2" }]).ok).toBe(false); // acting for another
    expect(attempt(run(reg, [judge(true)], g), bank("p_2")).ok).toBe(false); // already judged
    expect(attempt(play([...START, PRESENT]), bank("p_1")).ok).toBe(false); // chain at 0
  });

  it("a judgement names the player on turn (if given) and happens once", () => {
    const g = play([...START, PRESENT]);
    expect(attempt(g, ctl({ type: "answer.judge", participantId: "p_2", correct: true })).ok).toBe(false);
    const judged = run(reg, [judge(true)], g);
    expect(attempt(judged, judge(false)).ok).toBe(false);
  });

  it("the top step banks itself; a full bank ends the round", () => {
    const g = play([...START, ...turn(true), PRESENT, judge(true)], withRounds({ 0: { steps: [10, 20] } }));
    expect(viewOf(g)).toMatchObject({ bank: 20, level: 0, over: "target" });
    expect(viewOf(g).stats.find((x) => x.participantId === "p_2")?.banked).toBe(20);
    expect(run(reg, [NEXT], g).state.phase).toBe("round.end");
  });

  it("the bank stops at its target (bankTarget)", () => {
    const g = play([...START, ...turn(true), ...turn(true), PRESENT, bank("p_3")], withRounds({ 0: { steps: [10, 20, 50], bankTarget: 30 } }));
    expect(viewOf(g)).toMatchObject({ bank: 20, over: null });
    const full = run(reg, [judge(true), NEXT, ...turn(true), PRESENT, bank("p_1")], g);
    expect(viewOf(full)).toMatchObject({ bank: 30, over: "target" });
    expect(attempt(full, judge(true)).ok).toBe(false);
  });

  it("the control room ends the round (its time is up): the chain not banked is lost", () => {
    const g = play([...START, ...turn(true), PRESENT, bank("p_2"), judge(true), NEXT, PRESENT, ctl({ type: "chain.end" })]);
    expect(viewOf(g)).toMatchObject({ over: "ended", bank: 20, level: 1 });
    const next = run(reg, [NEXT, ctl({ type: "round.start" }), PRESENT], g);
    expect(viewOf(next)).toMatchObject({ bank: 0, level: 0, totalBank: 20 });
  });

  it("the control room can end the round between two turns", () => {
    const g = play([...START, ...turn(true), ctl({ type: "chain.end" })]);
    expect(viewOf(g).over).toBe("ended");
    expect(attempt(g, PRESENT).ok).toBe(false);
  });

  it("running out of questions ends the round", () => {
    const g = play([...START, ...turn(true), PRESENT, judge(true)], withRounds({ 0: { questions: ["q_ch1_1", "q_ch1_2"] } }));
    expect(viewOf(g).over).toBe("questions");
  });
});

describe("chain projections", () => {
  it("the expected answer is for the host and the control room until the reveal", () => {
    const g = play([...START, PRESENT, OPEN, judge(false), LOCK]);
    expect(viewOf(g, { role: "host" }).expected).toBe("Mars");
    expect(viewOf(g, { role: "player", participantId: "p_1" }).expected).toBeNull();
    expect(viewOf(g, { role: "output", scene: "program" }).expected).toBeNull();
    const shown = run(reg, [REVEAL], g);
    expect(viewOf(shown, { role: "output", scene: "program" }).expected).toBe("Mars");
    expect(project(shown, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "wrong" });
  });

  it("between turns every screen still shows the chain and the bank", () => {
    const g = play([...START, ...turn(true), ...turn(true)]);
    expect(g.state.phase).toBe("idle");
    expect(viewOf(g, { role: "output", scene: "program" })).toMatchObject({ level: 2, chainValue: 50, expected: null });
  });

  it("strongest and weakest links of the round: most right answers, then most banked", () => {
    const g = play([...START, ...turn(true), ...turn(true), PRESENT, bank("p_3"), judge(false), NEXT, ...turn(true)]);
    expect(viewOf(g)).toMatchObject({ strongest: "p_1", weakest: "p_3" });
  });
});

/** Round 1 over (4 questions): p_1, p_2 right, p_3 banks 50 then wrong, p_4 right; then the control room ends it. */
const ROUND_1: Step[] = [...START, ...turn(true), ...turn(true), PRESENT, bank("p_3"), judge(false), NEXT, ...turn(true), ctl({ type: "chain.end" }), ctl({ type: "round.start", roundIndex: 1 })];

describe("elimination vote", () => {
  it("opens only once the chain round is over, with 3 players or more", () => {
    expect(attempt(play([...START, ...turn(true)]), OPEN_VOTE).ok).toBe(false);
    expect(attempt(play([...START, PRESENT]), OPEN_VOTE).ok).toBe(false); // a question is on air
    expect(attempt(play(ROUND_1), OPEN_VOTE).ok).toBe(true);
  });

  it("votes stay secret from players and outputs until the vote is closed", () => {
    const g = play([...ROUND_1, OPEN_VOTE, vote("p_1", "p_3"), vote("p_2", "p_3")]);
    const out = viewOf(g, { role: "output", scene: "program" }).vote;
    expect(out).toMatchObject({ status: "open", cast: 2, ballots: null, tally: null, myVote: null });
    const mine = viewOf(g, { role: "player", participantId: "p_1" }).vote;
    expect(mine).toMatchObject({ ballots: null, tally: null, myVote: "p_3" });
    expect(viewOf(g, { role: "player", participantId: "p_3" }).vote?.myVote).toBeNull();
    expect(JSON.stringify(project(g, { role: "player", participantId: "p_3" }, reg))).not.toContain('"against"');
    expect(viewOf(g, { role: "control" }).vote?.ballots).toHaveLength(2);
  });

  it("refuses a vote against oneself, from or against a player out of the round, twice the same", () => {
    const g = play([...ROUND_1, OPEN_VOTE, vote("p_1", "p_3")]);
    expect(attempt(g, vote("p_2", "p_2")).ok).toBe(false);
    expect(attempt(g, vote("p_1", "p_3")).ok).toBe(false);
    expect(attempt(g, [actor("player", "p_2"), { type: "chain.vote", participantId: "p_1", against: "p_2" }]).ok).toBe(false);
    const late = run(reg, [ctl({ type: "player.add", participantId: "p_9", displayName: "Tard", channel: "seat" })], g);
    expect(attempt(late, vote("p_9", "p_1")).ok).toBe(false);
    expect(attempt(late, vote("p_2", "p_9")).ok).toBe(false);
  });

  it("most votes is eliminated when the vote closes; the next round goes on without them", () => {
    const g = play([...ROUND_1, OPEN_VOTE, vote("p_1", "p_3"), vote("p_2", "p_3"), vote("p_3", "p_1"), vote("p_4", "p_2"), CLOSE_VOTE]);
    expect(viewOf(g, { role: "output", scene: "program" }).vote).toMatchObject({
      status: "done",
      eliminated: "p_3",
      tally: [{ participantId: "p_3", votes: 2 }, { participantId: "p_1", votes: 1 }, { participantId: "p_2", votes: 1 }, { participantId: "p_4", votes: 0 }],
    });
    expect(statusOf(g, "p_3")).toBe("eliminated");
    const next = run(reg, [PRESENT], g);
    expect(viewOf(next)).toMatchObject({ order: ["p_1", "p_2", "p_4"], turn: "p_1", totalBank: 50, bank: 0, eliminations: [{ roundIndex: 0, participantId: "p_3" }] });
    expect(attempt(g, OPEN_VOTE).ok).toBe(false); // one vote per round
  });

  it("the next round cannot start while the vote is open", () => {
    const g = play([...ROUND_1, OPEN_VOTE]);
    expect(attempt(g, PRESENT).ok).toBe(false);
  });

  it("a tie is settled by the strongest link of the round, from their tablet or by the control room", () => {
    const g = play([...ROUND_1, OPEN_VOTE, vote("p_1", "p_3"), vote("p_2", "p_4"), vote("p_3", "p_4"), vote("p_4", "p_3"), CLOSE_VOTE]);
    expect(viewOf(g).vote).toMatchObject({ status: "tie", tied: ["p_3", "p_4"], picker: "p_1", eliminated: null });
    expect(statusOf(g, "p_3")).toBe("active");
    expect(attempt(g, [actor("player", "p_2"), { type: "chain.pick", participantId: "p_2", eliminated: "p_3" }]).ok).toBe(false); // not the strongest link
    expect(attempt(g, [actor("player", "p_1"), { type: "chain.pick", participantId: "p_1", eliminated: "p_2" }]).ok).toBe(false); // not tied
    const picked = run(reg, [[actor("player", "p_1"), { type: "chain.pick", participantId: "p_1", eliminated: "p_4" }]], g);
    expect(statusOf(picked, "p_4")).toBe("eliminated");
    const byControl = run(reg, [ctl({ type: "chain.pick", participantId: "p_1", eliminated: "p_3" })], g);
    expect(statusOf(byControl, "p_3")).toBe("eliminated");
  });

  it("undoing the close brings the player back; replay agrees", () => {
    const g = play([...ROUND_1, OPEN_VOTE, vote("p_1", "p_3"), vote("p_2", "p_3"), CLOSE_VOTE]);
    const u = run(reg, [ctl({ type: "undo" })], g);
    expect(statusOf(u, "p_3")).toBe("active");
    expect(viewOf(u).vote?.status).toBe("open");
    expect(replay(u.session, u.events, reg).state).toEqual(u.state);
  });
});

/** Two chain rounds (banks 50 and 20), two votes: p_3 then p_4 out; the duel round starts (p_1 strongest of round 2). */
const TO_DUEL: Step[] = [
  ...ROUND_1, OPEN_VOTE, vote("p_1", "p_3"), vote("p_2", "p_3"), CLOSE_VOTE,
  ...turn(false), PRESENT, judge(true), NEXT, PRESENT, bank("p_4"), judge(false), NEXT, ...turn(true), ctl({ type: "chain.end" }),
  OPEN_VOTE, vote("p_1", "p_4"), vote("p_2", "p_4"), vote("p_4", "p_1"), CLOSE_VOTE, ctl({ type: "round.start", roundIndex: 2 }),
];
const duelTurn = (correct: boolean): Step[] => [PRESENT, judge(correct), NEXT];

describe("final duel", () => {
  it("is played by exactly two players", () => {
    const three = play([...ROUND_1, OPEN_VOTE, vote("p_1", "p_3"), vote("p_2", "p_3"), CLOSE_VOTE, ctl({ type: "round.start", roundIndex: 2 })]);
    const r = attempt(three, PRESENT);
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringMatching(/deux joueurs/) } });
  });

  it("the two answer in turn, the stronger first; the pot is every bank of the game", () => {
    const g = play([...TO_DUEL, PRESENT]);
    expect(viewOf(g)).toMatchObject({ stage: "duel", order: ["p_1", "p_2"], turn: "p_1", totalBank: 70, duel: { questionsEach: 5, suddenDeath: false, winner: null } });
    expect(viewOf(run(reg, [judge(true), NEXT, PRESENT], g)).turn).toBe("p_2");
  });

  it("ends as soon as one cannot catch up; the winner takes the whole pot, nobody scored before", () => {
    let g = play(TO_DUEL);
    expect(g.state.ledger).toEqual([]);
    // p_1 right ×3, p_2 wrong ×3: after p_2's third miss, 3 to 0 with 2 questions each left → p_1 wins.
    for (let i = 0; i < 2; i++) g = run(reg, [...duelTurn(true), ...duelTurn(false)], g);
    g = run(reg, [...duelTurn(true), PRESENT, judge(false)], g);
    expect(viewOf(g).duel).toMatchObject({ winner: "p_1" });
    const end = run(reg, [NEXT], g);
    expect(end.state.phase).toBe("game.end");
    expect(participantTotal(end.state, "p_1")).toBe(70);
    expect(participantTotal(end.state, "p_2")).toBe(0);
    expect(viewOf(end, { role: "output", scene: "program" }).duel?.winner).toBe("p_1");
  });

  it("the reveal of the deciding question writes the pot once", () => {
    let g = play(TO_DUEL);
    for (let i = 0; i < 2; i++) g = run(reg, [...duelTurn(true), ...duelTurn(false)], g);
    g = run(reg, [...duelTurn(true), PRESENT, OPEN, judge(false), LOCK, REVEAL], g);
    expect(participantTotal(g.state, "p_1")).toBe(70);
    expect(participantTotal(run(reg, [NEXT], g).state, "p_1")).toBe(70);
  });

  it("tied after 5 each: sudden death by pairs", () => {
    let g = play(TO_DUEL);
    for (let i = 0; i < 5; i++) g = run(reg, [...duelTurn(true), ...duelTurn(true)], g);
    expect(viewOf(g).duel).toMatchObject({ suddenDeath: true, winner: null });
    g = run(reg, [...duelTurn(false)], g);
    expect(viewOf(g).duel?.winner).toBeNull(); // p_2 has not answered their question of the pair
    g = run(reg, [PRESENT, judge(true)], g);
    expect(viewOf(g).duel?.winner).toBe("p_2");
    expect(participantTotal(run(reg, [NEXT], g).state, "p_2")).toBe(70);
  });

  it("no bank and no vote in the duel", () => {
    const g = play([...TO_DUEL, PRESENT]);
    expect(attempt(g, bank("p_1")).ok).toBe(false);
    expect(attempt(g, ctl({ type: "chain.end" })).ok).toBe(false);
  });
});

describe("chain journal", () => {
  it("a whole game replays identically, also from a mid-game snapshot read back from disk", () => {
    const g = play([...TO_DUEL, ...duelTurn(true), ...duelTurn(false)]);
    expect(replay(g.session, g.events, reg).state).toEqual(g.state);
    const mid = 40;
    const snap = GameState.parse(JSON.parse(JSON.stringify(replay(g.session, g.events.slice(0, mid), reg).state))); // as read back from SQLite
    expect(replay(g.session, g.events, reg, { seq: mid, state: snap }).state).toEqual(g.state);
  });

  it("ends a vote between rounds through the control room only, never a player", () => {
    const g = play(ROUND_1);
    expect(attempt(g, [actor("player", "p_1"), { type: "chain.openVote" }]).ok).toBe(false);
    expect(attempt(g, [actor("host"), { type: "chain.openVote" }]).ok).toBe(false); // unless the host drives
  });
});
