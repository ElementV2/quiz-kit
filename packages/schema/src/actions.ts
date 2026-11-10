import { z } from "zod";
import { OptionId, ParticipantId, ScoreEntryId, TeamId } from "./ids.ts";
import type { Role } from "./roles.ts";
import { DisplayName, ParticipantStatus, ScoreTarget, Channel } from "./session.ts";

const action = <T extends string, S extends z.core.$ZodLooseShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), ...shape });

export const AnswerValue = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("choice"), optionIds: z.array(OptionId).min(1).max(6) }),
]);
export type AnswerValue = z.infer<typeof AnswerValue>;

export const Action = z.discriminatedUnion("type", [
  // Flow (control)
  action("game.start", {}),
  action("round.start", { roundIndex: z.number().int().min(0).optional() }),
  action("question.present", { questionIndex: z.number().int().min(0).optional() }),
  action("question.open", {}),
  action("question.lock", {}),
  action("question.reveal", {}),
  action("question.next", {}),
  // Answers
  action("answer.submit", { participantId: ParticipantId, answer: AnswerValue }),
  action("answer.judge", { participantId: ParticipantId, correct: z.boolean() }),
  // Scores (overrides, always accepted)
  action("score.adjust", {
    target: ScoreTarget,
    delta: z.number().int().min(-1_000_000).max(1_000_000),
    reason: z.enum(["bonus", "penalty", "manual"]).default("manual"),
    note: z.string().max(200).optional(),
  }),
  action("score.setTotal", { target: ScoreTarget, total: z.number().int().min(-1_000_000).max(1_000_000) }),
  action("score.void", { entryId: ScoreEntryId }),
  // Timer
  action("timer.set", { remainingMs: z.number().int().min(0).max(3_600_000) }),
  action("timer.stop", {}),
  /** Injected by the server only. `timerId` = seq of the event that armed it (stale expirations are ignored). */
  action("timer.expired", { timerId: z.number().int().min(0) }),
  // Players & teams
  action("player.add", {
    participantId: ParticipantId,
    displayName: DisplayName,
    teamId: TeamId.optional(),
    seat: z.number().int().min(1).max(999).optional(),
    channel: Channel.default("seat"),
  }),
  action("player.rename", { participantId: ParticipantId, displayName: DisplayName }),
  action("player.setStatus", { participantId: ParticipantId, status: ParticipantStatus }),
  action("player.setTeam", { participantId: ParticipantId, teamId: TeamId.nullable() }),
  action("player.setSeat", { participantId: ParticipantId, seat: z.number().int().min(1).max(999).nullable() }),
  action("player.remove", { participantId: ParticipantId }),
  action("team.add", {
    teamId: TeamId,
    name: z.string().trim().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  // Undo (ADR-0010)
  action("undo", { targetSeq: z.number().int().min(1).optional() }),
]);
export type Action = z.infer<typeof Action>;
export type ActionType = Action["type"];
export type ActionOf<T extends ActionType> = Extract<Action, { type: T }>;

const CONTROL_ONLY: readonly ActionType[] = [
  "game.start", "round.start", "question.present", "question.open", "question.lock", "question.reveal",
  "question.next", "timer.set", "timer.stop", "player.add", "player.rename", "player.setStatus",
  "player.setTeam", "player.setSeat", "player.remove", "team.add", "undo",
];
const SCORING: readonly ActionType[] = ["score.adjust", "score.setTotal", "score.void"];

/** Role → allowed actions (doc 01). Checked by the server AND the engine. */
export const actionPermissions: Readonly<Record<Role, ReadonlySet<ActionType>>> = {
  control: new Set<ActionType>([...CONTROL_ONLY, ...SCORING, "answer.submit", "answer.judge"]),
  "control-readonly": new Set<ActionType>(),
  scorer: new Set<ActionType>([...SCORING, "answer.judge"]),
  host: new Set<ActionType>(["answer.judge"]),
  output: new Set<ActionType>(),
  player: new Set<ActionType>(["answer.submit"]),
  seat: new Set<ActionType>(["answer.submit"]),
  studio: new Set<ActionType>(),
  system: new Set<ActionType>(["timer.expired"]),
};

export function isAllowed(role: Role, type: ActionType): boolean {
  return actionPermissions[role].has(type);
}

/** Actions that `undo` without target may cancel: control decisions, never player answers. */
export function isControlDecision(type: ActionType): boolean {
  return type !== "answer.submit" && type !== "timer.expired" && type !== "undo";
}
