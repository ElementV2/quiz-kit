import { z } from "zod";
import { OptionId, TeamId, type ActionOf, type PollBoardMechanicView, type Phase } from "@quiz/schema";
import { defineMechanic, type Judgement, type MechanicEnv } from "../../mechanic.ts";
import { assertNever, err, ok, type Rejection, type Result } from "../../result.ts";
import { roundHalfAway } from "../../scoring.ts";

/**
 * "Une famille en or" (doc 03). The team with the hand answers orally; control matches the answer to a
 * slot (`answer.judge { optionId, correct: true }`, which reveals it) or gives a strike
 * (`answer.judge { correct: false }`). At `maxStrikes`, control hands the steal to another team
 * (`poll.steal`), whose single answer is judged the same way. The bank (sum of found values × multiplier)
 * goes to the stealing team if its steal is right, to the team with the hand otherwise. It is written to
 * the ledger on `question.reveal`. The remaining slots stay masked until control flips them
 * (`element.reveal`), before or after `question.reveal`: flipped slots score for nobody.
 */

export const PollBoardConfig = z.strictObject({
  maxStrikes: z.number().int().min(1).max(10).default(3),
  /** Bank multiplier (double / triple rounds). Rounded symmetrically to an integer. */
  multiplier: z.number().positive().max(100).default(1),
});
export type PollBoardConfig = z.infer<typeof PollBoardConfig>;

const Slot = z.strictObject({
  optionId: OptionId,
  label: z.string(),
  value: z.number(),
  revealed: z.boolean(),
  found: z.boolean(),
});

export const PollBoardState = z.strictObject({
  /** Sorted by value, highest first (index 0 = top answer). */
  slots: z.array(Slot),
  maxStrikes: z.number().int().min(1),
  multiplier: z.number().positive(),
  strikes: z.number().int().min(0),
  stage: z.enum(["play", "steal", "done"]),
  controllingTeamId: TeamId.nullable(),
  stealingTeamId: TeamId.nullable(),
  /** Set when the stage becomes `done` (all slots found, or steal resolved). */
  winnerTeamId: TeamId.nullable(),
});
export type PollBoardState = z.infer<typeof PollBoardState>;

type S = PollBoardState;
type R = Result<S, Rejection>;

const bankOf = (s: S): number => s.slots.reduce((sum, x) => (x.found ? sum + x.value : sum), 0);

/** Phases in which the play goes on: answers are open (or just locked, to finish judging). */
const PLAYING: ReadonlySet<Phase> = new Set(["open", "locked", "judging"]);
const SHOWN: ReadonlySet<Phase> = new Set(["presenting", "open", "locked", "judging", "revealed"]);

function giveHand(s: S, a: ActionOf<"poll.control">, env: MechanicEnv): R {
  if (env.phase !== "presenting" && env.phase !== "open") return err("wrong-phase", "la main se donne avant ou pendant le jeu");
  if (s.stage !== "play") return err("conflict", "le jeu de cette équipe est terminé");
  if (s.controllingTeamId === a.teamId) return err("conflict", "cette équipe a déjà la main");
  return ok({ ...s, controllingTeamId: a.teamId });
}

function handSteal(s: S, a: ActionOf<"poll.steal">, env: MechanicEnv): R {
  if (!PLAYING.has(env.phase)) return err("wrong-phase", "les réponses ne sont pas ouvertes");
  if (s.stage !== "steal") return err("conflict", `le vol n'est possible qu'après ${s.maxStrikes} erreur(s)`);
  if (a.teamId === s.controllingTeamId) return err("conflict", "l'équipe qui a la main ne peut pas voler");
  if (s.stealingTeamId === a.teamId) return err("conflict", "cette équipe tente déjà le vol");
  return ok({ ...s, stealingTeamId: a.teamId });
}

function find(s: S, optionId: string | undefined): Result<number, Rejection> {
  if (optionId === undefined) return err("invalid", "une bonne réponse doit désigner sa case (optionId)");
  const i = s.slots.findIndex((x) => x.optionId === optionId);
  if (i < 0) return err("not-found", "réponse absente du sondage");
  if (s.slots[i]?.revealed === true) return err("conflict", "case déjà révélée");
  return ok(i);
}

const markFound = (s: S, i: number): S["slots"] => s.slots.map((x, j) => (j === i ? { ...x, revealed: true, found: true } : x));

function judgeAnswer(s: S, a: ActionOf<"answer.judge">, env: MechanicEnv): R {
  if (!PLAYING.has(env.phase)) return err("wrong-phase", "les réponses ne sont pas ouvertes");
  switch (s.stage) {
    case "play": {
      if (s.controllingTeamId === null) return err("conflict", "donner la main à une équipe d'abord (poll.control)");
      if (!a.correct) {
        const strikes = s.strikes + 1;
        return ok({ ...s, strikes, stage: strikes >= s.maxStrikes ? "steal" : "play" });
      }
      const i = find(s, a.optionId);
      if (!i.ok) return i;
      const slots = markFound(s, i.value);
      const allFound = slots.every((x) => x.revealed);
      return ok({ ...s, slots, stage: allFound ? "done" : "play", winnerTeamId: allFound ? s.controllingTeamId : null });
    }
    case "steal": {
      if (s.stealingTeamId === null) return err("conflict", "désigner l'équipe qui tente le vol d'abord (poll.steal)");
      if (!a.correct) return ok({ ...s, stage: "done", winnerTeamId: s.controllingTeamId });
      const i = find(s, a.optionId);
      if (!i.ok) return i;
      return ok({ ...s, slots: markFound(s, i.value), stage: "done", winnerTeamId: s.stealingTeamId });
    }
    case "done":
      return err("conflict", "le jeu est terminé pour cette question");
    default:
      return assertNever(s.stage);
  }
}

function flip(s: S, a: ActionOf<"element.reveal">, env: MechanicEnv): R {
  if (!SHOWN.has(env.phase)) return err("wrong-phase", "aucune question affichée");
  const slot = s.slots[a.index];
  if (slot === undefined) return err("not-found", `case ${a.index} inexistante`);
  if (slot.revealed) return err("conflict", "case déjà révélée");
  return ok({ ...s, slots: s.slots.map((x, j) => (j === a.index ? { ...x, revealed: true } : x)) });
}

export const pollBoard = defineMechanic<PollBoardConfig, PollBoardState>({
  id: "poll-board",
  configSchema: PollBoardConfig,
  stateSchema: PollBoardState,

  init(cfg, question) {
    const spec = question.answerSpec;
    if (spec.kind !== "poll") return err("unsupported", `la mécanique poll-board ne gère que les sondages (pas ${spec.kind})`);
    const slots: S["slots"] = [];
    for (const o of spec.options) {
      if (o.value === undefined) return err("invalid", `la réponse « ${o.label} » n'a pas de valeur (%)`);
      slots.push({ optionId: o.id, label: o.label, value: o.value, revealed: false, found: false });
    }
    return ok({
      slots: slots.toSorted((x, y) => y.value - x.value), // stable: equal values keep the authored order
      maxStrikes: cfg.maxStrikes,
      multiplier: cfg.multiplier,
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
    const winner = s.winnerTeamId ?? s.controllingTeamId;
    if (winner === null) return [];
    const points = roundHalfAway(bankOf(s) * s.multiplier);
    const out: Judgement[] = [{ kind: "fixed", target: { teamId: winner }, outcome: points > 0 ? "correct" : "wrong", points }];
    // The other side of a steal gets its result (no points).
    const loser = s.stage === "done" && s.stealingTeamId !== null ? (winner === s.stealingTeamId ? s.controllingTeamId : s.stealingTeamId) : null;
    if (loser !== null) out.push({ kind: "fixed", target: { teamId: loser }, outcome: "wrong", points: 0 });
    return out;
  },

  endsRound() {
    return false;
  },

  removeParticipant(s) {
    return s; // nothing per participant: the board belongs to teams
  },

  answerOf() {
    return null;
  },

  answers() {
    return [];
  },

  project(s, env): PollBoardMechanicView {
    const privileged = env.audience === "host" || env.audience === "control";
    return {
      mechanic: "poll-board",
      slots: s.slots.map((x, index) => {
        const shown = x.revealed || privileged;
        return { index, revealed: x.revealed, found: x.found, label: shown ? x.label : null, value: shown ? x.value : null };
      }),
      strikes: s.strikes,
      maxStrikes: s.maxStrikes,
      stage: s.stage,
      controllingTeamId: s.controllingTeamId,
      stealingTeamId: s.stealingTeamId,
      bank: bankOf(s),
      multiplier: s.multiplier,
      winnerTeamId: s.winnerTeamId,
    };
  },
});
