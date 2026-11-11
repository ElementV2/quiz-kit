import { z } from "zod";
import { OptionId, ParticipantId, TeamId, type ActionOf, type PollBoardMechanicView, type Phase, type ScoreTarget, unsupportedQuestion } from "@quiz/schema";
import { defineMechanic, type Judgement, type MechanicEnv } from "../../mechanic.ts";
import { assertNever, err, ok, type Rejection, type Result } from "../../result.ts";
import { roundHalfAway } from "../../scoring.ts";

/** A setting read from a state that an older snapshot may lack (raw JSON, no defaults applied). */
const flag = (v: boolean | undefined, byDefault: boolean): boolean => v ?? byDefault;

/**
 * "Une famille en or" (doc 03). The team with the hand answers orally; control matches the answer to a
 * slot (`answer.judge { optionId, correct: true }`, which reveals it) or gives a strike
 * (`answer.judge { correct: false }`). At `maxStrikes`, control hands the steal to another team
 * (`poll.steal`), whose single answer is judged the same way. The bank (sum of found values × multiplier)
 * goes to the stealing team if its steal is right, to the team with the hand otherwise. It is written to
 * the ledger on `question.reveal`, which also shows the whole board to everyone (found slots stay marked).
 * Before it, control may flip a slot (`element.reveal`): flipped slots score for nobody. The hand may pass to
 * another team at any time before the reveal (`poll.control`: strikes restart, a steal in progress is dropped).
 */

export const PollBoardConfig = z.strictObject({
  maxStrikes: z.number().int().min(1).max(10).default(3),
  /** Bank multiplier (double / triple rounds). Rounded symmetrically to an integer. */
  multiplier: z.number().positive().max(100).default(1),
  /**
   * `per-answer`: every team scores the value of each answer IT found (simple, what most shows want).
   * `bank`: TV rule — the whole bank goes to the team that wins the question (hand kept, or a successful steal).
   * Default `bank` so journals written before replay identically; new rounds are created `per-answer`.
   */
  scoring: z.enum(["per-answer", "bank"]).default("bank"),
  /** After the last strike, another side may try to steal. Off: the question ends there. */
  steal: z.boolean().default(true),
  /** At the reveal, show the answers nobody found. Off: only the found ones stay on the board. */
  revealAll: z.boolean().default(true),
  /** Strikes back to zero when the hand passes. Off: they are kept (shared by every side of the question). */
  strikesReset: z.boolean().default(true),
});
export type PollBoardConfig = z.infer<typeof PollBoardConfig>;

/** A team (`t_…`) or, in a game played individually, a player (`p_…`): the prefix tells which. */
const Side = z.union([TeamId, ParticipantId]);
/** Score target of a side. */
const targetOf = (side: string): ScoreTarget => (side.startsWith("p_") ? { participantId: side } : { teamId: side });

const Slot = z.strictObject({
  optionId: OptionId,
  label: z.string(),
  value: z.number(),
  revealed: z.boolean(),
  found: z.boolean(),
  /** Team — or player, in a game played individually — that found it (null: flipped by control). */
  foundBy: Side.nullable().default(null),
});

export const PollBoardState = z.strictObject({
  /** Sorted by value, highest first (index 0 = top answer). */
  slots: z.array(Slot),
  maxStrikes: z.number().int().min(1),
  multiplier: z.number().positive(),
  scoring: z.enum(["per-answer", "bank"]).default("bank"),
  steal: z.boolean().default(true),
  revealAll: z.boolean().default(true),
  strikesReset: z.boolean().default(true),
  strikes: z.number().int().min(0),
  stage: z.enum(["play", "steal", "done"]),
  controllingTeamId: Side.nullable(),
  stealingTeamId: Side.nullable(),
  /** Set when the stage becomes `done` (all slots found, or steal resolved). */
  winnerTeamId: Side.nullable(),
});
export type PollBoardState = z.infer<typeof PollBoardState>;

type S = PollBoardState;
type R = Result<S, Rejection>;

const bankOf = (s: S): number => s.slots.reduce((sum, x) => (x.found ? sum + x.value : sum), 0);

/** Phases in which the play goes on: answers are open (or just locked, to finish judging). */
const PLAYING: ReadonlySet<Phase> = new Set(["open", "locked", "judging"]);
const SHOWN: ReadonlySet<Phase> = new Set(["presenting", "open", "locked", "judging", "revealed"]);

/**
 * Gives the hand — first, or to the other team at any time while the question is played (the host decides). The
 * answers found stay on the board (the bank goes to whoever wins it), the strikes restart for the team taking over,
 * a steal attempt in progress is dropped.
 */
const sideOf = (a: { readonly teamId?: string | undefined; readonly participantId?: string | undefined }): string => a.teamId ?? a.participantId ?? "";

function giveHand(s: S, a: ActionOf<"poll.control">, env: MechanicEnv): R {
  if (!SHOWN.has(env.phase) || env.phase === "revealed") return err("wrong-phase", "la main se donne pendant la question (avant la révélation)");
  // Over (strikes used, no steal) while answers remain: another side may still be given the hand.
  if (s.stage === "done" && s.slots.every((x) => x.found)) return err("conflict", "toutes les réponses sont trouvées");
  const side = sideOf(a);
  if (s.controllingTeamId === side && s.stage !== "done") return err("conflict", "a déjà la main");
  const strikes = flag(s.strikesReset, true) ? 0 : s.strikes;
  // Strikes kept and all used: the new side gets one more try (else giving the hand would be pointless).
  return ok({ ...s, controllingTeamId: side, strikes: strikes >= s.maxStrikes ? s.maxStrikes - 1 : strikes, stage: "play", stealingTeamId: null, winnerTeamId: null });
}

function handSteal(s: S, a: ActionOf<"poll.steal">, env: MechanicEnv): R {
  if (!PLAYING.has(env.phase)) return err("wrong-phase", "les réponses ne sont pas ouvertes");
  if (s.stage !== "steal") return err("conflict", `le vol n'est possible qu'après ${s.maxStrikes} erreur(s)`);
  const side = sideOf(a);
  if (side === s.controllingTeamId) return err("conflict", "qui a la main ne peut pas voler");
  if (s.stealingTeamId === side) return err("conflict", "le vol est déjà en cours pour elle");
  return ok({ ...s, stealingTeamId: side });
}

function find(s: S, optionId: string | undefined): Result<number, Rejection> {
  if (optionId === undefined) return err("invalid", "une bonne réponse doit désigner sa case (optionId)");
  const i = s.slots.findIndex((x) => x.optionId === optionId);
  if (i < 0) return err("not-found", "réponse absente du sondage");
  if (s.slots[i]?.revealed === true) return err("conflict", "case déjà révélée");
  return ok(i);
}

const markFound = (s: S, i: number, team: string | null): S["slots"] => s.slots.map((x, j) => (j === i ? { ...x, revealed: true, found: true, foundBy: team } : x));

/** Per-answer scoring: what each team found (values × multiplier), teams that played and found nothing at 0. */
function pointsByTeam(s: S): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of [s.controllingTeamId, s.stealingTeamId]) if (t !== null) out.set(t, 0);
  for (const x of s.slots) if (x.found && x.foundBy !== null && x.foundBy !== undefined) out.set(x.foundBy, (out.get(x.foundBy) ?? 0) + x.value);
  for (const [t, v] of out) out.set(t, roundHalfAway(v * s.multiplier));
  return out;
}

function judgeAnswer(s: S, a: ActionOf<"answer.judge">, env: MechanicEnv): R {
  if (!PLAYING.has(env.phase)) return err("wrong-phase", "les réponses ne sont pas ouvertes");
  switch (s.stage) {
    case "play": {
      if (s.controllingTeamId === null) return err("conflict", "donner la main à une équipe d'abord (poll.control)");
      if (!a.correct) {
        const strikes = s.strikes + 1;
        if (strikes < s.maxStrikes) return ok({ ...s, strikes, stage: "play" });
        // Last strike: the steal — or, without steal, the end (the side with the hand keeps what it found).
        return ok(!flag(s.steal, true) ? { ...s, strikes, stage: "done", winnerTeamId: s.controllingTeamId } : { ...s, strikes, stage: "steal" });
      }
      const i = find(s, a.optionId);
      if (!i.ok) return i;
      const slots = markFound(s, i.value, s.controllingTeamId);
      const allFound = slots.every((x) => x.revealed);
      return ok({ ...s, slots, stage: allFound ? "done" : "play", winnerTeamId: allFound ? s.controllingTeamId : null });
    }
    case "steal": {
      if (s.stealingTeamId === null) return err("conflict", "désigner l'équipe qui tente le vol d'abord (poll.steal)");
      if (!a.correct) return ok({ ...s, stage: "done", winnerTeamId: s.controllingTeamId });
      const i = find(s, a.optionId);
      if (!i.ok) return i;
      return ok({ ...s, slots: markFound(s, i.value, s.stealingTeamId), stage: "done", winnerTeamId: s.stealingTeamId });
    }
    case "done":
      return err("conflict", "le jeu est terminé pour cette question");
    default:
      return assertNever(s.stage);
  }
}

function flip(s: S, a: ActionOf<"element.reveal">, env: MechanicEnv): R {
  if (!SHOWN.has(env.phase)) return err("wrong-phase", "aucune question affichée");
  if (env.phase === "revealed") return err("wrong-phase", "toutes les réponses sont déjà affichées");
  const slot = s.slots[a.index];
  if (slot === undefined) return err("not-found", `case ${a.index} inexistante`);
  if (slot.revealed) return err("conflict", "case déjà révélée");
  return ok({ ...s, slots: s.slots.map((x, j) => (j === a.index ? { ...x, revealed: true } : x)) });
}

export const pollBoard = defineMechanic<PollBoardConfig, PollBoardState>({
  id: "poll-board",
  configSchema: PollBoardConfig,
  stateSchema: PollBoardState,
  ownPoints: true,

  reconfigure(s, cfg) {
    // Display and flow settings: safe mid-question (the bank / the found answers do not move).
    return { ...s, steal: cfg.steal, revealAll: cfg.revealAll, strikesReset: cfg.strikesReset, maxStrikes: Math.max(cfg.maxStrikes, s.strikes) };
  },

  init(cfg, question) {
    const spec = question.answerSpec;
    if (spec.kind !== "poll") return err("unsupported", `${unsupportedQuestion("poll-board", spec.kind)} (sondages seulement)`);
    const slots: S["slots"] = [];
    for (const o of spec.options) {
      if (o.value === undefined || o.value < 0) return err("invalid", `la réponse « ${o.label} » n'a pas de valeur (%) positive`);
      slots.push({ optionId: o.id, label: o.label, value: o.value, revealed: false, found: false, foundBy: null });
    }
    return ok({
      slots: slots.toSorted((x, y) => y.value - x.value), // stable: equal values keep the authored order
      maxStrikes: cfg.maxStrikes,
      multiplier: cfg.multiplier,
      scoring: cfg.scoring,
      steal: cfg.steal,
      revealAll: cfg.revealAll,
      strikesReset: cfg.strikesReset,
      strikes: 0,
      stage: "play",
      controllingTeamId: null,
      stealingTeamId: null,
      winnerTeamId: null,
    });
  },

  submit() {
    return err("unsupported", "sondage à slots : réponses orales, validées par la régie (answer.judge)");
  },

  onAction(s, a, env) {
    if (a.type === "poll.control") return giveHand(s, a, env);
    if (a.type === "poll.steal") return handSteal(s, a, env);
    if (a.type === "answer.judge") return judgeAnswer(s, a, env);
    if (a.type === "element.reveal") return flip(s, a, env);
    return null;
  },

  judge(s): Judgement[] {
    if ((s.scoring ?? "bank") === "per-answer") { // an older snapshot may lack it: bank, as it was played
      return [...pointsByTeam(s)].map(([side, points]): Judgement => ({ kind: "fixed", target: targetOf(side), outcome: points > 0 ? "correct" : "wrong", points }));
    }
    const winner = s.winnerTeamId ?? s.controllingTeamId;
    if (winner === null) return [];
    const points = roundHalfAway(bankOf(s) * s.multiplier);
    const out: Judgement[] = [{ kind: "fixed", target: targetOf(winner), outcome: points > 0 ? "correct" : "wrong", points }];
    // The other side of a steal gets its result (no points).
    const loser = s.stage === "done" && s.stealingTeamId !== null ? (winner === s.stealingTeamId ? s.controllingTeamId : s.stealingTeamId) : null;
    if (loser !== null) out.push({ kind: "fixed", target: targetOf(loser), outcome: "wrong", points: 0 });
    return out;
  },

  endsRound() {
    return false;
  },

  closeRound() {
    return [];
  },

  removeParticipant(s, participantId) {
    // A player may hold the hand (game played individually): a removed one keeps nothing — an id reused later must
    // not inherit the hand, a steal or the answers found. Holding the hand: back to « give the hand ».
    const off = (side: string | null): string | null => (side === participantId ? null : side);
    const held = s.controllingTeamId === participantId;
    return {
      ...s,
      slots: s.slots.map((x) => (x.foundBy === participantId ? { ...x, foundBy: null } : x)),
      controllingTeamId: off(s.controllingTeamId),
      stealingTeamId: off(s.stealingTeamId),
      winnerTeamId: off(s.winnerTeamId),
      ...(held ? { stage: "play" as const, strikes: 0, stealingTeamId: null } : {}),
    };
  },

  answerOf() {
    return null;
  },

  answers() {
    return [];
  },

  project(s, env): PollBoardMechanicView {
    const privileged = env.audience === "host" || env.audience === "control";
    // « Révéler » shows the whole board, as on TV: answers found stay marked (found), the others appear at the end.
    // Projection only: the bank still counts found answers.
    const end = env.phase === "revealed" && flag(s.revealAll, true);
    return {
      mechanic: "poll-board",
      slots: s.slots.map((x, index) => {
        const revealed = x.revealed || end;
        const shown = revealed || privileged;
        return { index, revealed, found: x.found, foundBy: x.foundBy ?? null, optionId: shown ? x.optionId : null, label: shown ? x.label : null, value: shown ? x.value : null };
      }),
      strikes: s.strikes,
      maxStrikes: s.maxStrikes,
      stage: s.stage,
      controllingTeamId: s.controllingTeamId,
      stealingTeamId: s.stealingTeamId,
      bank: bankOf(s),
      multiplier: s.multiplier,
      winnerTeamId: s.winnerTeamId,
      scoring: s.scoring ?? "bank",
      teamPoints: s.scoring === "per-answer" ? [...pointsByTeam(s)].map(([teamId, points]) => ({ teamId, points })) : [],
    };
  },
});
