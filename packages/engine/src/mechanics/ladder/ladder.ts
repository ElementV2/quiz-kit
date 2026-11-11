import { z } from "zod";
import { JokerKind, Media, OptionId, ParticipantId, type ActionOf, type LadderJokerState, type LadderMechanicView, type Phase } from "@quiz/schema";
import { defineMechanic, type Judgement, type MechanicEnv } from "../../mechanic.ts";
import { assertNever, err, ok, type Rejection, type Result } from "../../result.ts";
import type { Rng } from "../../rng.ts";

/**
 * Ladder (QVGDM, doc 03): a round-level mechanic. One candidate (the first participant whose answer is
 * accepted in the round) answers `single` questions; each right answer climbs one step. A wrong answer
 * falls back to the last safe step reached and ends the round; `ladder.stop` keeps the step reached and
 * ends the round; the top step (or the last question of the round) ends it too. The final gain is written
 * to the ledger once: on the `question.reveal` that ends the ladder (a `fixed` judgement), or on the
 * `question.next` that ends the round when no reveal did (`closeRound`: last question skipped, stop
 * without reveal). Intermediate reveals write nothing. Going back to an earlier question is refused. Progression and used jokers travel from question to question through the
 * round context (`GameState.carry`).
 *
 * Jokers, once per game each, before the answer:
 * - `fifty`: hides 2 wrong options (fewer with 3 options), drawn with `env.rng` → deterministic on replay.
 * - `audience`: the engine draws the poll with `env.rng`, biased towards the right answer (simplest
 *   option, no operator input): the right option gets 35–75 %, the rest is split at random between the
 *   other visible options (largest remainder, sum = 100). So it is usually, not always, the majority.
 */

const strictlyIncreasing = (xs: readonly number[]): boolean => xs.every((x, i) => i === 0 || x > (xs[i - 1] ?? x));
const unique = (xs: readonly unknown[]): boolean => new Set(xs).size === xs.length;

export const LadderConfig = z
  .strictObject({
    /** Amount of each step, strictly increasing. */
    steps: z.array(z.number().int().min(0).max(1_000_000)).min(1).max(30).refine(strictlyIncreasing, "les paliers doivent être strictement croissants"),
    /** Indices (in `steps`) of the safe steps. */
    safeSteps: z.array(z.number().int().min(0)).default([]).refine(unique, "palier assuré en double"),
    /** Jokers available in this game, each usable once. */
    jokers: z.array(JokerKind).default(["fifty", "audience"]).refine(unique, "joker en double"),
  })
  .refine((c) => c.safeSteps.every((i) => i < c.steps.length), "palier assuré hors des paliers");
export type LadderConfig = z.infer<typeof LadderConfig>;

export const LadderState = z.strictObject({
  steps: z.array(z.number().int()),
  safeSteps: z.array(z.number().int()),
  jokers: z.array(JokerKind),
  options: z.array(z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() })),
  correct: OptionId,
  /** Steps won before this question. */
  level: z.number().int().min(0),
  candidate: ParticipantId.nullable(),
  answer: z.strictObject({ optionId: OptionId, at: z.number().int() }).nullable(),
  stopped: z.boolean(),
  jokersUsed: z.array(JokerKind),
  /** 50:50 on this question. */
  hidden: z.array(OptionId),
  /** Audience poll on this question (% per option). */
  audience: z.record(OptionId, z.number().int()).nullable(),
  /** No question left in the round after this one. */
  lastQuestion: z.boolean(),
});
export type LadderState = z.infer<typeof LadderState>;

type S = LadderState;
type R = Result<S, Rejection>;
type Outcome = "none" | "correct" | "wrong" | "stopped";

const gainAt = (s: S, level: number): number => (level === 0 ? 0 : (s.steps[level - 1] ?? 0));
const securedAt = (s: S, level: number): number => s.safeSteps.reduce((best, i) => (i < level ? Math.max(best, s.steps[i] ?? 0) : best), 0);

/** Pure function of the recorded answer: never of the phase (judge() contract). */
function outcomeOf(s: S): Outcome {
  if (s.stopped) return "stopped";
  if (s.answer === null) return "none";
  return s.answer.optionId === s.correct ? "correct" : "wrong";
}

/** This question ends the ladder if revealed with this outcome. */
function isFinal(s: S, o: Outcome): boolean {
  switch (o) {
    case "none":
      return false;
    case "stopped":
    case "wrong":
      return true;
    case "correct":
      return s.level + 1 >= s.steps.length || s.lastQuestion;
    default:
      return assertNever(o);
  }
}

const BEFORE_LOCK: ReadonlySet<Phase> = new Set(["presenting", "open"]);
const IN_QUESTION: ReadonlySet<Phase> = new Set(["presenting", "open", "locked", "judging"]);

function stop(s: S, env: MechanicEnv): R {
  if (!IN_QUESTION.has(env.phase)) return err("wrong-phase", "aucune question en jeu");
  if (s.candidate === null) return err("conflict", "aucun candidat : rien à garder");
  if (s.stopped) return err("conflict", "le candidat s'est déjà arrêté");
  if (s.answer !== null) return err("conflict", "réponse déjà donnée : annuler la réponse avant d'arrêter");
  return ok({ ...s, stopped: true });
}

function useJoker(s: S, a: ActionOf<"joker.use">, env: MechanicEnv): R {
  if (!BEFORE_LOCK.has(env.phase)) return err("wrong-phase", "les jokers se jouent avant le verrouillage");
  if (!s.jokers.includes(a.joker)) return err("forbidden", `joker ${a.joker} non prévu dans ce jeu`);
  if (s.jokersUsed.includes(a.joker)) return err("conflict", `joker ${a.joker} déjà utilisé`);
  if (s.stopped) return err("conflict", "le candidat s'est arrêté");
  if (s.answer !== null) return err("conflict", "réponse déjà donnée");
  const used = [...s.jokersUsed, a.joker];
  switch (a.joker) {
    case "fifty": {
      const wrong = s.options.filter((o) => o.id !== s.correct && !s.hidden.includes(o.id)).map((o) => o.id);
      const visible = s.options.length - s.hidden.length;
      const count = Math.min(2, visible - 2);
      if (count <= 0) return err("unsupported", "50:50 impossible avec deux options visibles");
      const drawn = new Set(env.rng.shuffle(wrong).slice(0, count));
      return ok({ ...s, jokersUsed: used, hidden: s.options.map((o) => o.id).filter((id) => s.hidden.includes(id) || drawn.has(id)) });
    }
    case "audience":
      return ok({ ...s, jokersUsed: used, audience: drawAudience(s, env.rng) });
    default:
      return assertNever(a.joker);
  }
}

/** Integer % per option, sum 100, biased towards the right answer (see header). */
function drawAudience(s: S, rng: Rng): Record<string, number> {
  const correctShare = 35 + rng.int(41);
  const others = s.options.filter((o) => o.id !== s.correct && !s.hidden.includes(o.id));
  const weights = others.map(() => 1 + rng.int(10));
  const total = weights.reduce((a, b) => a + b, 0);
  const rest = others.length === 0 ? 0 : 100 - correctShare;
  const exact = weights.map((w) => (rest * w) / total);
  const alloc = exact.map(Math.floor);
  let left = rest - alloc.reduce((a, b) => a + b, 0);
  // Largest remainder first; ties keep option order.
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).toSorted((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    alloc[i] = (alloc[i] ?? 0) + 1;
    left--;
  }
  const poll: Record<string, number> = {};
  for (const o of s.options) poll[o.id] = 0;
  poll[s.correct] = 100 - rest;
  for (const [i, o] of others.entries()) poll[o.id] = alloc[i] ?? 0;
  return poll;
}

const jokerState = (s: S, j: JokerKind): LadderJokerState =>
  !s.jokers.includes(j) ? "disabled" : s.jokersUsed.includes(j) ? "used" : "available";

export const ladder = defineMechanic<LadderConfig, LadderState>({
  id: "ladder",
  configSchema: LadderConfig,
  stateSchema: LadderState,

  init(cfg, question, _env, round) {
    const spec = question.answerSpec;
    if (spec.kind !== "single") return err("unsupported", `la mécanique ladder ne gère que les QCM à une réponse (pas ${spec.kind})`);
    let level = 0;
    let candidate: string | null = null;
    let jokersUsed: S["jokersUsed"] = [];
    const prev = round.previous;
    if (prev !== null) {
      // Going back would count the replayed question's step twice: undo is the way to replay.
      if (round.questionIndex <= prev.questionIndex) return err("conflict", "question de paliers déjà jouée : annuler (undo) pour la rejouer");
      const o = outcomeOf(prev.state);
      if (prev.state.stopped || (prev.revealed && isFinal(prev.state, o))) return err("conflict", "partie de paliers terminée : démarrer une nouvelle manche");
      level = prev.state.level + (prev.revealed && o === "correct" ? 1 : 0);
      candidate = prev.state.candidate;
      jokersUsed = [...prev.state.jokersUsed];
    }
    return ok({
      steps: [...cfg.steps],
      safeSteps: [...cfg.safeSteps],
      jokers: [...cfg.jokers],
      options: spec.options.map(({ id, label, media }) => (media ? { id, label, media } : { id, label })),
      correct: spec.correct,
      level,
      candidate,
      answer: null,
      stopped: false,
      jokersUsed,
      hidden: [],
      audience: null,
      lastQuestion: round.questionsLeft === 0,
    });
  },

  submit(s, participantId, answer, env) {
    switch (answer.kind) {
      case "choice": {
        if (s.candidate !== null && s.candidate !== participantId) return err("conflict", "seul le candidat répond");
        if (s.stopped) return err("conflict", "le candidat s'est arrêté");
        const [optionId, ...more] = answer.optionIds;
        if (optionId === undefined || more.length > 0) return err("invalid", "une seule réponse");
        if (!s.options.some((o) => o.id === optionId)) return err("invalid", "option inconnue");
        if (s.hidden.includes(optionId)) return err("invalid", "option retirée par le 50:50");
        return ok({ ...s, candidate: participantId, answer: { optionId, at: env.at } });
      }
      case "text":
      case "number":
      case "order":
      case "pairs":
      case "pin":
      case "allocation":
        return err("invalid", "réponse à choix attendue");
      default:
        return assertNever(answer);
    }
  },

  onAction(s, a, env) {
    if (a.type === "ladder.stop") return stop(s, env);
    if (a.type === "joker.use") return useJoker(s, a, env);
    return null;
  },

  judge(s): Judgement[] {
    if (s.candidate === null) return [];
    const target = { participantId: s.candidate };
    const o = outcomeOf(s);
    switch (o) {
      case "none":
        return [];
      case "stopped":
        return [{ kind: "fixed", target, outcome: "correct", points: gainAt(s, s.level) }];
      case "correct":
        return [{ kind: "fixed", target, outcome: "correct", points: isFinal(s, o) ? gainAt(s, s.level + 1) : 0 }];
      case "wrong":
        return [{ kind: "fixed", target, outcome: "wrong", points: securedAt(s, s.level) }];
      default:
        return assertNever(o);
    }
  },

  endsRound(s, phase) {
    // A stop ends the ladder even without reveal (control may skip the reveal).
    return s.stopped || (phase === "revealed" && isFinal(s, outcomeOf(s)));
  },

  closeRound(s, phase) {
    // The reveal that ended the ladder already wrote the gain. Otherwise (last question skipped, stop
    // without reveal, revealed without answer) the candidate keeps the step reached before this question.
    if (s.candidate === null || (phase === "revealed" && isFinal(s, outcomeOf(s)))) return [];
    return [{ kind: "fixed", target: { participantId: s.candidate }, outcome: "correct", points: gainAt(s, s.level) }];
  },

  removeParticipant(s, participantId) {
    // A reused id must inherit nothing: the ladder restarts from scratch.
    if (s.candidate !== participantId) return s;
    return { ...s, level: 0, candidate: null, answer: null, stopped: false, jokersUsed: [], hidden: [], audience: null };
  },

  answerOf(s, participantId) {
    return s.answer !== null && s.candidate === participantId ? [s.answer.optionId] : null;
  },

  answers(s) {
    return s.answer === null || s.candidate === null ? [] : [{ participantId: s.candidate, optionIds: [s.answer.optionId], at: s.answer.at }];
  },

  project(s, env): LadderMechanicView {
    const revealed = env.phase === "revealed";
    const privileged = env.audience === "host" || env.audience === "control";
    // Before reveal nothing depends on the answer's correctness (no-leak, tested).
    const o: Outcome = revealed ? outcomeOf(s) : s.stopped ? "stopped" : "none";
    const level = o === "correct" ? s.level + 1 : s.level;
    const final = revealed && isFinal(s, o);
    let status: LadderMechanicView["status"] = "playing";
    if (o === "stopped") status = "stopped";
    else if (final) status = o === "wrong" ? "lost" : "won";
    return {
      mechanic: "ladder",
      options: s.options.map((x) => ({ ...x })),
      hidden: [...s.hidden],
      audience: s.audience === null ? null : { ...s.audience },
      correct: revealed || privileged ? s.correct : null,
      steps: [...s.steps],
      safeSteps: [...s.safeSteps],
      level,
      atStake: final ? null : s.level,
      gain: status === "lost" ? securedAt(s, level) : gainAt(s, level),
      secured: securedAt(s, level),
      candidate: s.candidate,
      answer: s.answer?.optionId ?? null,
      status,
      jokers: { fifty: jokerState(s, "fifty"), audience: jokerState(s, "audience") },
    };
  },
});
