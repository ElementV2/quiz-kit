import { z } from "zod";
import { ChainStat, ParticipantId, type ActionOf, type ChainMechanicView, type ChainVoteView, type Phase, unsupportedQuestion } from "@quiz/schema";
import { defineMechanic, type FixedJudgement, type Judgement, type MechanicEnv } from "../../mechanic.ts";
import { err, ok, type Rejection, type Result } from "../../result.ts";

/**
 * « La chaîne » (façon Maillon faible, doc 03, ADR-0016) — a round-spanning mechanic.
 *
 * Chain round (`stage: chain`): the active players answer in turn (stable order taken at the round's first question,
 * one question each, rotating). Answers are spoken; the host / control room judges (`answer.judge`). Right: the chain
 * climbs one step; wrong: it falls to 0. Before their answer is judged, the player on turn (or the host / control room)
 * may bank (`chain.bank`): the chain's value goes to the round bank, the chain restarts at 0. The top step banks
 * itself. The round ends when the bank reaches its target (`bankTarget`, else the last step), when its questions run out,
 * or when the control room ends it (`chain.end`: its time is up). What is not banked is lost.
 *
 * Between rounds: the elimination vote (`chain.openVote` → `chain.vote` → `chain.closeVote`); most votes is eliminated
 * (status set by the core, `eliminates`); a tie is settled by the round's strongest link (`chain.pick`).
 *
 * Final duel (`stage: duel`): the two players left answer in turn (the stronger of the last round first), `questionsEach`
 * questions each, then sudden death by pairs. The duel stops as soon as one cannot catch up. The winner takes every
 * bank of the game, written to the ledger once: at the reveal of the deciding question, else at the `question.next` that
 * ends the round (`closeRound`). Nothing is scored before: banks are shown, not scored.
 *
 * Banks, stats, vote and eliminations travel from question to question (`RoundContext.previous`) and from round to round
 * (`RoundContext.earlier`, `GameState.across`): the whole game is in the journaled state (replay, undo, reconnection).
 */

const strictlyIncreasing = (xs: readonly number[]): boolean => xs.every((x, i) => i === 0 || x > (xs[i - 1] ?? x));

export const NO_STEPS = "la chaîne n'a aucun montant : renseigner les paliers de la chaîne dans les réglages de la manche";

export const ChainConfig = z.strictObject({
  /** `chain`: a chain round; `duel`: the final duel of the two last players. */
  stage: z.enum(["chain", "duel"]).default("chain"),
  /**
   * Amount of each step of the chain, strictly increasing. No amount is imposed: an empty list (the default) is
   * refused when the round's first question is presented (`NO_STEPS`), so the studio can keep a draft.
   */
  steps: z.array(z.number().int().min(1).max(10_000_000)).max(30).default([]).refine(strictlyIncreasing, "les montants de la chaîne doivent être strictement croissants"),
  /** The round ends when the bank reaches it. Absent: the last step. */
  bankTarget: z.number().int().min(1).max(100_000_000).optional(),
  /** Final duel: questions each before sudden death. */
  questionsEach: z.number().int().min(1).max(20).default(5),
});
export type ChainConfig = z.infer<typeof ChainConfig>;

const ChainVote = z.strictObject({
  status: z.enum(["open", "tie", "done"]),
  voters: z.array(ParticipantId),
  ballots: z.array(z.strictObject({ voter: ParticipantId, against: ParticipantId })),
  tied: z.array(ParticipantId),
  picker: ParticipantId.nullable(),
  eliminated: ParticipantId.nullable(),
});

export const ChainState = z.strictObject({
  stage: z.enum(["chain", "duel"]),
  /** Round this state belongs to. */
  roundIndex: z.number().int().min(0),
  steps: z.array(z.number().int()),
  /** Bank target of the chain round (0 in a duel). */
  target: z.number().int().min(0),
  questionsEach: z.number().int().min(1),
  /** Players of the round, in turn order (active players at the round's first question). */
  order: z.array(ParticipantId),
  /** Position in `order` of the turn; kept when that player is removed (the next turn starts there). */
  slot: z.number().int().min(0),
  turn: ParticipantId.nullable(),
  /** Expected answer of the question on air (SECRET until revealed, except host / control). */
  expected: z.string(),
  verdict: z.boolean().nullable(),
  /** Steps climbed by the current chain. */
  level: z.number().int().min(0),
  /** Banked this round. */
  bank: z.number().int().min(0),
  over: z.enum(["target", "questions", "ended"]).nullable(),
  lastQuestion: z.boolean(),
  stats: z.array(ChainStat),
  /** Banks of the earlier chain rounds of the game (the current one is `bank`). */
  banks: z.array(z.strictObject({ roundIndex: z.number().int().min(0), amount: z.number().int().min(0) })),
  eliminations: z.array(z.strictObject({ roundIndex: z.number().int().min(0), participantId: ParticipantId })),
  /** Elimination vote of this round (between rounds only). */
  vote: ChainVote.nullable(),
  /** Duel won. */
  winner: ParticipantId.nullable(),
  /** The winner was decided on this question (its reveal writes the pot). */
  decidedHere: z.boolean(),
});
export type ChainState = z.infer<typeof ChainState>;

type S = ChainState;
type R = Result<S, Rejection>;
type Stat = S["stats"][number];

const ON_AIR: ReadonlySet<Phase> = new Set(["presenting", "open", "locked", "judging"]);

const valueAt = (s: S, level: number): number => (level === 0 ? 0 : (s.steps[level - 1] ?? 0));
const sum = (xs: readonly { readonly amount: number }[]): number => xs.reduce((t, x) => t + x.amount, 0);
/** Every bank of the game so far, this round's included: the duel winner's prize. */
const potOf = (s: S): number => sum(s.banks) + (s.stage === "chain" ? s.bank : 0);
const asked = (st: Stat | undefined): number => (st === undefined ? 0 : st.right + st.wrong);
const statOf = (stats: readonly Stat[], id: string): Stat | undefined => stats.find((x) => x.participantId === id);

function bump(stats: readonly Stat[], id: string, d: { right?: number; wrong?: number; banked?: number }): Stat[] {
  return stats.map((x) => (x.participantId === id ? { ...x, right: x.right + (d.right ?? 0), wrong: x.wrong + (d.wrong ?? 0), banked: x.banked + (d.banked ?? 0) } : x));
}

/** > 0 when a is stronger than b: more right answers, then more banked. */
const strength = (a: Stat | undefined, b: Stat | undefined): number => (a?.right ?? 0) - (b?.right ?? 0) || (a?.banked ?? 0) - (b?.banked ?? 0);

/** Strongest (dir 1) or weakest (dir -1) among `ids`; ties: the first in `ids`. */
function link(stats: readonly Stat[], ids: readonly string[], dir: 1 | -1): string | null {
  let best: string | null = null;
  for (const id of ids) if (best === null || dir * strength(statOf(stats, id), statOf(stats, best)) > 0) best = id;
  return best;
}

/** Next position in the turn order: the first active player after the last turn (at its place if it was removed). */
function nextSlot(s: S, isActive: (id: string) => boolean): number | null {
  const n = s.order.length;
  const start = s.turn === null ? s.slot : s.slot + 1;
  for (let k = 0; k < n; k++) {
    const j = (start + k) % n;
    const id = s.order[j];
    if (id !== undefined && isActive(id)) return j;
  }
  return null;
}

/** Duel: whoever has been asked fewer questions; the first player opens each pair. */
function duelSlot(s: S): number {
  const [a, b] = s.order;
  return a !== undefined && b !== undefined && asked(statOf(s.stats, b)) < asked(statOf(s.stats, a)) ? 1 : 0;
}

/** Duel winner: one cannot catch up within the regular questions, or a sudden-death pair ends unequal. */
function duelWinner(s: S, stats: readonly Stat[]): string | null {
  const [a, b] = s.order;
  if (a === undefined || b === undefined) return null;
  const sa = statOf(stats, a);
  const sb = statOf(stats, b);
  const [ra, rb, qa, qb] = [sa?.right ?? 0, sb?.right ?? 0, asked(sa), asked(sb)];
  const n = s.questionsEach;
  if (qa < n || qb < n) {
    if (ra > rb + Math.max(0, n - qb)) return a;
    if (rb > ra + Math.max(0, n - qa)) return b;
    return null;
  }
  if (qa !== qb || ra === rb) return null;
  return ra > rb ? a : b;
}

const overMessage = (s: S): string => (s.stage === "duel" ? "duel terminé : passer à la suite" : "manche de chaîne terminée : passer à la suite");

function judgeAnswer(s: S, a: ActionOf<"answer.judge">, env: MechanicEnv): R {
  if (!ON_AIR.has(env.phase)) return err("wrong-phase", "aucune question de la chaîne à juger (le jugement se fait avant la révélation)");
  if (s.over !== null || s.winner !== null) return err("conflict", overMessage(s));
  if (s.turn === null) return err("conflict", "personne n'a la parole sur cette question");
  if (a.participantId !== undefined && a.participantId !== s.turn) return err("conflict", "ce n'est pas son tour de répondre");
  if (s.verdict !== null) return err("conflict", "réponse déjà jugée : annuler (undo) pour corriger");
  const stats = bump(s.stats, s.turn, a.correct ? { right: 1 } : { wrong: 1 });
  if (s.stage === "duel") {
    const winner = duelWinner(s, stats);
    return ok({ ...s, verdict: a.correct, stats, winner, decidedHere: winner !== null });
  }
  let level = a.correct ? s.level + 1 : 0;
  let bank = s.bank;
  let banked = stats;
  if (level >= s.steps.length) {
    // Top of the chain: it banks itself.
    const added = Math.max(0, Math.min(valueAt(s, s.steps.length), s.target - bank));
    bank += added;
    banked = bump(stats, s.turn, { banked: added });
    level = 0;
  }
  const over = bank >= s.target ? "target" : s.lastQuestion ? "questions" : null;
  return ok({ ...s, verdict: a.correct, level, bank, stats: banked, over });
}

function bankChain(s: S, a: ActionOf<"chain.bank">, env: MechanicEnv): R {
  if (!ON_AIR.has(env.phase)) return err("wrong-phase", "la banque se fait pendant sa question, avant sa réponse");
  if (s.stage !== "chain") return err("conflict", "pas de banque pendant le duel final");
  if (s.over !== null) return err("conflict", overMessage(s));
  if (s.turn !== a.participantId) return err("conflict", "seul le joueur dont c'est le tour met en banque");
  if (s.verdict !== null) return err("conflict", "réponse déjà jugée : la banque se fait avant la réponse");
  const value = valueAt(s, s.level);
  if (value === 0) return err("conflict", "chaîne à zéro : rien à mettre en banque");
  const added = Math.min(value, s.target - s.bank);
  const bank = s.bank + added;
  return ok({ ...s, bank, level: 0, stats: bump(s.stats, a.participantId, { banked: added }), over: bank >= s.target ? "target" : null });
}

function endChain(s: S, env: MechanicEnv): R {
  if (s.stage !== "chain") return err("unsupported", "le duel se termine par ses questions (corriger les points à la main si besoin)");
  if (s.over !== null) return err("conflict", "manche de chaîne déjà terminée");
  // On air, or between two turns of its own round (not once the round is over or another one started).
  const between = env.phase === "idle" && env.roundIndex === s.roundIndex && !s.lastQuestion;
  if (!ON_AIR.has(env.phase) && env.phase !== "revealed" && !between) return err("wrong-phase", "manche de chaîne déjà terminée");
  return ok({ ...s, over: "ended" });
}

const BETWEEN_ROUNDS: ReadonlySet<Phase> = new Set(["idle", "round.end"]);

function openVote(s: S, env: MechanicEnv): R {
  if (!BETWEEN_ROUNDS.has(env.phase)) return err("wrong-phase", "le vote se fait entre deux manches : passer d'abord à la suite");
  if (s.stage !== "chain") return err("conflict", "pas de vote après le duel final");
  if (s.vote !== null) return err("conflict", s.vote.status === "done" ? "vote déjà fait pour cette manche (annuler pour le refaire)" : "vote déjà ouvert");
  const finished = s.over !== null || s.lastQuestion || env.phase === "round.end" || env.roundIndex !== s.roundIndex;
  if (!finished) return err("conflict", "la manche de chaîne n'est pas finie : la terminer d'abord");
  const voters = s.order.filter((id) => env.activePlayers === undefined || env.activePlayers.includes(id));
  if (voters.length < 3) return err("conflict", `vote à partir de 3 joueurs en jeu (${voters.length} ici) : à deux, place au duel final`);
  return ok({ ...s, vote: { status: "open", voters, ballots: [], tied: [], picker: null, eliminated: null } });
}

function castVote(s: S, a: ActionOf<"chain.vote">): R {
  const v = s.vote;
  if (v === null || v.status !== "open") return err("conflict", "aucun vote d'élimination ouvert");
  if (!v.voters.includes(a.participantId)) return err("forbidden", "ce joueur ne vote pas : il n'était pas en jeu dans cette manche");
  if (a.against === a.participantId) return err("invalid", "on ne vote pas contre soi-même");
  if (!v.voters.includes(a.against)) return err("invalid", "voter contre un joueur de la manche");
  if (v.ballots.some((b) => b.voter === a.participantId && b.against === a.against)) return err("conflict", "vote déjà enregistré");
  const ballots = [...v.ballots.filter((b) => b.voter !== a.participantId), { voter: a.participantId, against: a.against }];
  return ok({ ...s, vote: { ...v, ballots } });
}

/** Votes received by each voter, most first (ties: turn order). */
function tallyOf(v: NonNullable<S["vote"]>): { participantId: string; votes: number }[] {
  return v.voters.map((id) => ({ participantId: id, votes: v.ballots.filter((b) => b.against === id).length })).toSorted((x, y) => y.votes - x.votes);
}

const withElimination = (s: S, v: NonNullable<S["vote"]>, id: string): S => ({
  ...s,
  vote: { ...v, status: "done", eliminated: id },
  eliminations: [...s.eliminations.filter((e) => e.participantId !== id), { roundIndex: s.roundIndex, participantId: id }],
});

function closeVote(s: S): R {
  const v = s.vote;
  if (v === null || v.status !== "open") return err("conflict", "aucun vote d'élimination ouvert");
  const tally = tallyOf(v);
  const max = tally[0]?.votes ?? 0;
  const leaders = tally.filter((t) => t.votes === max).map((t) => t.participantId);
  const [only] = leaders;
  if (leaders.length === 1 && only !== undefined) return ok(withElimination(s, v, only));
  // Tie: the strongest link of the round picks among the tied players.
  return ok({ ...s, vote: { ...v, status: "tie", tied: leaders, picker: link(s.stats, v.voters, 1) } });
}

function pick(s: S, a: ActionOf<"chain.pick">): R {
  const v = s.vote;
  if (v === null || v.status !== "tie") return err("conflict", "aucune égalité à départager");
  if (a.participantId !== v.picker) return err("forbidden", "seul le maillon fort de la manche départage");
  if (a.eliminated === v.picker) return err("invalid", "le maillon fort ne s'élimine pas lui-même");
  if (!v.tied.includes(a.eliminated)) return err("invalid", "choisir parmi les joueurs à égalité");
  return ok(withElimination(s, v, a.eliminated));
}

function voteView(s: S, v: NonNullable<S["vote"]>, privileged: boolean, viewer: string | null): ChainVoteView {
  const shown = privileged || v.status !== "open";
  return {
    status: v.status,
    voters: [...v.voters],
    cast: v.ballots.length,
    ballots: shown ? v.ballots.map((b) => ({ ...b })) : null,
    tally: shown ? tallyOf(v) : null,
    tied: [...v.tied],
    picker: v.picker,
    eliminated: v.eliminated,
    myVote: viewer === null ? null : (v.ballots.find((b) => b.voter === viewer)?.against ?? null),
  };
}

/** What the round starts from: banks of the earlier chain rounds (a replayed round drops its own; a won duel paid them). */
function fromEarlier(e: S | null, roundIndex: number): Pick<S, "banks" | "eliminations"> {
  if (e === null) return { banks: [], eliminations: [] };
  if (e.stage === "duel" && e.winner !== null) return { banks: [], eliminations: [...e.eliminations] };
  const all = e.stage === "chain" ? [...e.banks.filter((b) => b.roundIndex !== e.roundIndex), { roundIndex: e.roundIndex, amount: e.bank }] : [...e.banks];
  return { banks: all.filter((b) => b.roundIndex !== roundIndex && b.amount > 0), eliminations: [...e.eliminations] };
}

export const chain = defineMechanic<ChainConfig, ChainState>({
  id: "chain",
  configSchema: ChainConfig,
  stateSchema: ChainState,
  ownPoints: true,
  noStakes: true,
  spansRounds: true,

  init(cfg, question, env, round) {
    const spec = question.answerSpec;
    const expected = spec.kind === "oral" ? spec.expected : spec.kind === "text" ? spec.accepted[0] : undefined;
    if (expected === undefined) return err("unsupported", `${unsupportedQuestion("chain", spec.kind)} (réponse orale ou libre)`);
    if (cfg.stage === "chain" && cfg.steps.length === 0) return err("invalid", NO_STEPS);
    const active = env.activePlayers;
    // No player known (static check of the studio): only the question and the settings are checked.
    const isActive = (id: string): boolean => active === undefined || active.includes(id);
    const lastQuestion = round.questionsLeft === 0;
    const prev = round.previous;
    if (prev !== null) {
      const p = prev.state;
      // Going back would replay a turn on top of its own result: undo is the way to replay.
      if (round.questionIndex <= prev.questionIndex) return err("conflict", "question de la chaîne déjà jouée : annuler (undo) pour la rejouer");
      if (p.over !== null || p.winner !== null) return err("conflict", overMessage(p));
      if (p.stage === "duel") {
        const [a, b] = p.order;
        if (a === undefined || b === undefined || !isActive(a) || !isActive(b)) return err("conflict", "duel : un des deux joueurs n'est plus en jeu (le remettre en jeu, ou corriger à la main)");
        const slot = duelSlot(p);
        return ok({ ...p, slot, turn: p.order[slot] ?? null, expected, verdict: null, lastQuestion, decidedHere: false });
      }
      const slot = nextSlot(p, isActive);
      if (slot === null) return err("conflict", "plus aucun joueur de la manche n'est en jeu");
      return ok({ ...p, slot, turn: p.order[slot] ?? null, expected, verdict: null, lastQuestion });
    }
    const roundIndex = round.roundIndex ?? 0;
    const e = round.earlier?.state ?? null;
    if (e !== null && e.vote !== null && e.vote.status !== "done") return err("conflict", "vote d'élimination en cours : le clore (ou l'annuler) avant de jouer");
    let order = active === undefined ? [] : [...active];
    if (active !== undefined && cfg.stage === "chain" && order.length === 0) return err("conflict", "aucun joueur en jeu pour la chaîne");
    if (active !== undefined && cfg.stage === "duel" && order.length !== 2) {
      return err("conflict", `le duel final se joue à deux joueurs en jeu (${order.length} actuellement : terminer le vote, ou régler les statuts dans l'onglet Joueurs)`);
    }
    // The duel: the stronger of the last chain round answers first.
    if (cfg.stage === "duel" && e !== null && e.stage === "chain") order = order.toSorted((x, y) => strength(statOf(e.stats, y), statOf(e.stats, x)));
    const steps = cfg.stage === "chain" ? [...cfg.steps] : [];
    return ok({
      stage: cfg.stage,
      roundIndex,
      steps,
      target: cfg.stage === "chain" ? (cfg.bankTarget ?? steps.at(-1) ?? 0) : 0,
      questionsEach: cfg.questionsEach,
      order,
      slot: 0,
      turn: order[0] ?? null,
      expected,
      verdict: null,
      level: 0,
      bank: 0,
      over: null,
      lastQuestion,
      stats: order.map((participantId) => ({ participantId, right: 0, wrong: 0, banked: 0 })),
      ...fromEarlier(e, roundIndex),
      vote: null,
      winner: null,
      decidedHere: false,
    });
  },

  submit() {
    return err("unsupported", "réponse orale : l'animateur ou la régie la juge (pas de saisie sur tablette)");
  },

  onAction(s, a, env) {
    if (a.type === "answer.judge") return judgeAnswer(s, a, env);
    if (a.type === "chain.bank") return bankChain(s, a, env);
    if (a.type === "chain.end") return endChain(s, env);
    if (a.type === "chain.openVote") return openVote(s, env);
    if (a.type === "chain.vote") return castVote(s, a);
    if (a.type === "chain.closeVote") return closeVote(s);
    if (a.type === "chain.pick") return pick(s, a);
    return null;
  },

  judge(s): Judgement[] {
    const out: Judgement[] = [];
    if (s.turn !== null && s.verdict !== null) out.push({ kind: "fixed", target: { participantId: s.turn }, outcome: s.verdict ? "correct" : "wrong", points: 0 });
    if (s.stage === "duel" && s.decidedHere && s.winner !== null) out.push({ kind: "fixed", target: { participantId: s.winner }, outcome: "correct", points: potOf(s) });
    return out;
  },

  endsRound(s) {
    return s.over !== null || s.winner !== null;
  },

  closeRound(s, phase): FixedJudgement[] {
    // The reveal of the deciding question already paid the pot; otherwise the round's end does.
    if (s.stage !== "duel" || s.winner === null || (phase === "revealed" && s.decidedHere)) return [];
    return [{ kind: "fixed", target: { participantId: s.winner }, outcome: "correct", points: potOf(s) }];
  },

  removeParticipant(s, pid) {
    // A reused id inherits nothing: no turn, no stats, no ballot, no win.
    const idx = s.order.indexOf(pid);
    const order = s.order.filter((id) => id !== pid);
    const stats = s.stats.filter((x) => x.participantId !== pid);
    const onTurn = s.turn === pid;
    const v = s.vote;
    let vote = v;
    if (v !== null) {
      const voters = v.voters.filter((id) => id !== pid);
      vote = {
        ...v,
        voters,
        ballots: v.ballots.filter((b) => b.voter !== pid && b.against !== pid),
        tied: v.tied.filter((id) => id !== pid),
        picker: v.picker === pid ? link(stats, voters, 1) : v.picker,
        eliminated: v.eliminated === pid ? null : v.eliminated,
      };
    }
    return {
      ...s,
      order,
      slot: idx >= 0 && idx < s.slot ? s.slot - 1 : s.slot,
      turn: onTurn ? null : s.turn,
      verdict: onTurn ? null : s.verdict,
      stats,
      vote,
      eliminations: s.eliminations.filter((e) => e.participantId !== pid),
      winner: s.winner === pid ? null : s.winner,
      decidedHere: s.winner === pid ? false : s.decidedHere,
    };
  },

  answerOf() {
    return null;
  },

  answers() {
    return [];
  },

  project(s, env): ChainMechanicView {
    const privileged = env.audience === "host" || env.audience === "control";
    const ids = s.stats.map((x) => x.participantId);
    const [a, b] = s.order;
    return {
      mechanic: "chain",
      stage: s.stage,
      order: [...s.order],
      turn: s.turn,
      expected: privileged || env.phase === "revealed" ? s.expected : null,
      verdict: s.verdict === null ? null : s.verdict ? "right" : "wrong",
      steps: [...s.steps],
      level: s.level,
      chainValue: valueAt(s, s.level),
      bank: s.bank,
      bankTarget: s.target,
      totalBank: potOf(s),
      over: s.over,
      stats: s.stats.map((x) => ({ ...x })),
      strongest: link(s.stats, ids, 1),
      weakest: link(s.stats, ids, -1),
      vote: s.vote === null ? null : voteView(s, s.vote, privileged, env.audience === "player" ? env.participantId : null),
      eliminations: s.eliminations.map((e) => ({ ...e })),
      duel:
        s.stage === "duel"
          ? { questionsEach: s.questionsEach, suddenDeath: a !== undefined && b !== undefined && asked(statOf(s.stats, a)) >= s.questionsEach && asked(statOf(s.stats, b)) >= s.questionsEach, winner: s.winner }
          : null,
    };
  },

  eliminates(before, after) {
    const out = after.vote?.eliminated ?? null;
    return out !== null && before.vote?.eliminated !== out ? [out] : [];
  },
});
