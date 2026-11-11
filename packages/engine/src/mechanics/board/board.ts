import { z } from "zod";
import { Media, OptionId, type BoardMechanicView, type Question } from "@quiz/schema";
import { defineMechanic, type Judgement, type Mechanic } from "../../mechanic.ts";
import { assertNever, err, ok } from "../../result.ts";
import { Buzz, buzzMe, handOf, lockedOutOf, onBuzz, onJudge, queueOf, winnerOf } from "../shared/buzz-queue.ts";

/**
 * Board (doc 03 `board`, Jeopardy-like). The round's questions form a grid: column = category (first tag of
 * the question, "Divers" without tag), row = rank in that column, value = `values[row]`. Control picks a
 * cell (`question.present { questionIndex }`, any order; without index: the first free cell), players buzz,
 * control / host judge the hand (`answer.judge`). Right: + value; wrong: − value when `penalty`, the hand
 * passes. The round ends when every cell has been played. Fixed points (the ScoringRule is not used).
 */

export const BoardConfig = z.strictObject({
  values: z.array(z.number().int().min(0).max(1_000_000)).min(1).max(10).default([100, 200, 300, 400, 500]),
  /** A wrong answer costs the cell value. */
  penalty: z.boolean().default(true),
  lockoutOnWrong: z.boolean().default(true),
});
export type BoardConfig = z.infer<typeof BoardConfig>;

const Cell = z.strictObject({ questionIndex: z.number().int(), category: z.string(), value: z.number().int() });

export const BoardState = z.strictObject({
  cells: z.array(Cell),
  /** Question indices played before this one (revealed or skipped). */
  played: z.array(z.number().int()),
  current: z.number().int(),
  kind: z.enum(["oral", "single"]),
  options: z.array(z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() })),
  /** Right option label (`single`) or expected answer (`oral` / `text`). */
  correct: z.string(),
  penalty: z.boolean(),
  lockoutOnWrong: z.boolean(),
  buzzes: z.array(Buzz),
});
export type BoardState = z.infer<typeof BoardState>;

const DEFAULT_CATEGORY = "Divers";

/** Grid of the round: same input → same grid (pure). Rows beyond `values` keep adding the last step. */
export function boardCells(questions: readonly Question[], values: readonly number[]): z.infer<typeof Cell>[] {
  const rankIn = new Map<string, number>();
  const last = values.at(-1) ?? 0;
  const step = values.length > 1 ? last - (values.at(-2) ?? 0) : last;
  // Questions the board cannot play (number, order…) get no cell: they would block the end of the round.
  return questions.flatMap((q, questionIndex) => {
    if (spoken(q) === null) return [];
    const category = q.tags[0] ?? DEFAULT_CATEGORY;
    const row = rankIn.get(category) ?? 0;
    rankIn.set(category, row + 1);
    return [{ questionIndex, category, value: values[row] ?? last + step * (row - values.length + 1) }];
  });
}

function gridView(cells: readonly z.infer<typeof Cell>[], played: readonly number[]): Pick<BoardMechanicView, "mechanic" | "categories"> {
  const names = [...new Set(cells.map((c) => c.category))];
  return {
    mechanic: "board",
    categories: names.map((name) => ({
      name,
      cells: cells.filter((c) => c.category === name).map((c) => ({ questionIndex: c.questionIndex, value: c.value, played: played.includes(c.questionIndex) })),
    })),
  };
}

function spoken(q: Question): Pick<BoardState, "kind" | "options" | "correct"> | null {
  const a = q.answerSpec;
  switch (a.kind) {
    case "oral":
      return { kind: "oral", options: [], correct: a.expected };
    case "text":
      return { kind: "oral", options: [], correct: a.accepted[0] ?? "" };
    case "single":
      return { kind: "single", options: a.options.map(({ id, label, media }) => (media ? { id, label, media } : { id, label })), correct: a.options.find((o) => o.id === a.correct)?.label ?? a.correct };
    case "multi":
    case "boolean":
    case "poll":
    case "number":
    case "order":
    case "pairs":
    case "pin":
    case "allocation":
      return null;
    default:
      return assertNever(a);
  }
}

export const board: Mechanic<BoardConfig, BoardState> = {
  id: "board",
  configSchema: BoardConfig,
  stateSchema: BoardState,
  ownPoints: true,
  freeOrder: true,

  init(cfg, question, _env, round) {
    const answer = spoken(question);
    if (answer === null) return err("unsupported", `la mécanique board ne gère pas les questions ${question.answerSpec.kind}`);
    const prev = round.previous;
    const played = prev === null ? [] : [...prev.state.played, prev.state.current];
    if (played.includes(round.questionIndex)) return err("conflict", "case déjà jouée");
    return ok({ cells: boardCells(round.questions, cfg.values), played, current: round.questionIndex, ...answer, penalty: cfg.penalty, lockoutOnWrong: cfg.lockoutOnWrong, buzzes: [] });
  },

  submit() {
    return err("unsupported", "plateau : buzzer d'abord, la réponse est donnée oralement");
  },

  onAction(s, a, env) {
    if (a.type === "buzz") return onBuzz(s, a, env);
    if (a.type === "answer.judge") return onJudge(s, a, env);
    return null;
  },

  // A cell judged right then skipped (question.next without reveal) keeps its value, as on TV.
  onSkip(s) {
    return board.judge(s).flatMap((j) => (j.kind === "fixed" ? [j] : []));
  },

  judge(s): Judgement[] {
    const value = s.cells.find((c) => c.questionIndex === s.current)?.value ?? 0;
    return s.buzzes.flatMap((b): Judgement[] => {
      if (b.status === "waiting") return [];
      const points = b.status === "correct" ? value : s.penalty ? -value : 0;
      return [{ kind: "fixed", target: { participantId: b.participantId }, outcome: b.status, points }];
    });
  },

  endsRound(s) {
    return s.played.length + 1 >= s.cells.length;
  },

  closeRound: () => [],
  removeParticipant: (s, pid) => ({ ...s, buzzes: s.buzzes.filter((b) => b.participantId !== pid) }),
  answerOf: () => null,
  answers: (s) => s.buzzes.map((b) => ({ participantId: b.participantId, optionIds: [], at: b.at })),

  projectIdle(cfg, questions, previous): BoardMechanicView {
    const played = previous === null ? [] : [...previous.played, previous.current];
    const cells = boardCells(questions, cfg.values);
    return { ...gridView(cells, played), cell: null, kind: "oral", options: null, correct: null, hand: null, winner: null, queue: null, lockedOut: null, me: null };
  },

  project(s, env): BoardMechanicView {
    const secrets = env.phase === "revealed" || env.audience === "host" || env.audience === "control";
    const light = env.audience === "player";
    const cell = s.cells.find((c) => c.questionIndex === s.current) ?? null;
    return {
      ...gridView(s.cells, s.played),
      cell: cell === null ? null : { ...cell },
      kind: s.kind,
      options: s.kind === "single" ? s.options.map((o) => ({ ...o })) : null,
      correct: secrets ? s.correct : null,
      hand: handOf(s),
      winner: winnerOf(s),
      queue: light ? null : queueOf(s),
      lockedOut: light ? null : lockedOutOf(s),
      me: buzzMe(s, env.audience, env.participantId, env.phase),
    };
  },
};

/** Registered form (generic parameters erased). */
export const boardMechanic = defineMechanic(board);
