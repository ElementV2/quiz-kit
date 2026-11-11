import { z } from "zod";
import { Phase } from "./phase.ts";
import { Media } from "./content.ts";
import { OptionId, ParticipantId, QuestionId, SessionId, TeamId } from "./ids.ts";
import { Participant, ParticipantStatus, ScoreEntry, Team } from "./session.ts";

/**
 * Projected views (ADR-0004, ADR-0007): the contract between the engine (producer) and the
 * renderer / apps (consumers). Secrets live in fields that are `null` for player / output before reveal.
 */

export { Phase } from "./phase.ts";

export const ChoiceMechanicView = z.strictObject({
  mechanic: z.literal("choice"),
  kind: z.enum(["single", "multi", "boolean"]),
  options: z.array(z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() })),
  minPick: z.number().int(),
  maxPick: z.number().int(),
  /** SECRET: null for player / output until `revealed`. */
  correct: z.array(OptionId).nullable(),
  /** Answer distribution. Host / control from `locked`, everyone from `revealed`, else null. */
  counts: z.record(OptionId, z.number().int()).nullable(),
  /** Live number of answers. Null for players: it would change every tablet's view on every answer (O(n²) broadcast). */
  answeredCount: z.number().int().nullable(),
});
export type ChoiceMechanicView = z.infer<typeof ChoiceMechanicView>;

export const MechanicView = z.discriminatedUnion("mechanic", [ChoiceMechanicView]);
export type MechanicView = z.infer<typeof MechanicView>;

export const LeaderboardRow = z.strictObject({
  participantId: ParticipantId,
  displayName: z.string(),
  teamId: TeamId.nullable(),
  total: z.number().int(),
  rank: z.number().int().min(1),
});
export type LeaderboardRow = z.infer<typeof LeaderboardRow>;

/** Rows sent to players: the top of the leaderboard only (their own rank is in `me`). */
export const PLAYER_LEADERBOARD_ROWS = 10;

export const BaseView = z.strictObject({
  sessionId: SessionId,
  phase: Phase,
  round: z.strictObject({ index: z.number().int(), count: z.number().int(), title: z.string() }).nullable(),
  question: z
    .strictObject({
      id: QuestionId,
      index: z.number().int(),
      count: z.number().int(),
      prompt: z.strictObject({ text: z.string(), media: Media.optional() }),
    })
    .nullable(),
  /** Wall-clock deadline (server time, ms) — clients display it using their clock offset. */
  timer: z.strictObject({ endsAt: z.number().int(), durationMs: z.number().int() }).nullable(),
  mechanic: MechanicView.nullable(),
  leaderboard: z.array(LeaderboardRow),
});
export type BaseView = z.infer<typeof BaseView>;

export const OutputView = BaseView.extend({ role: z.literal("output") });
export type OutputView = z.infer<typeof OutputView>;

export const PlayerView = BaseView.extend({
  role: z.literal("player"),
  me: z
    .strictObject({
      participantId: ParticipantId,
      displayName: z.string(),
      status: ParticipantStatus,
      teamId: TeamId.nullable(),
      total: z.number().int(),
      rank: z.number().int().min(1),
    })
    .nullable(),
  /** The player's own accepted answer (option ids), null if none. */
  myAnswer: z.array(OptionId).nullable(),
  /** Only after reveal. */
  myResult: z.enum(["correct", "wrong", "none"]).nullable(),
  canAnswer: z.boolean(),
});
export type PlayerView = z.infer<typeof PlayerView>;

export const HostView = BaseView.extend({
  role: z.literal("host"),
  notes: z.string().nullable(),
  nextQuestion: z.strictObject({ id: QuestionId, text: z.string() }).nullable(),
});
export type HostView = z.infer<typeof HostView>;

export const ControlView = BaseView.extend({
  role: z.literal("control"),
  readonly: z.boolean(),
  notes: z.string().nullable(),
  nextQuestion: z.strictObject({ id: QuestionId, text: z.string() }).nullable(),
  participants: z.array(Participant),
  teams: z.array(Team),
  ledger: z.array(ScoreEntry),
  answers: z.array(z.strictObject({ participantId: ParticipantId, optionIds: z.array(OptionId), at: z.number().int() })),
  /** Events ignored during the last replay because they became invalid after an undo (ADR-0010). */
  skipped: z.array(z.strictObject({ seq: z.number().int(), type: z.string(), reason: z.string() })),
  lastSeq: z.number().int(),
  /** Run-down (doc 08): every round and question with its status, for the control room's left column. */
  rundown: z.array(
    z.strictObject({
      index: z.number().int(),
      title: z.string(),
      mechanic: z.string(),
      questions: z.array(z.strictObject({ index: z.number().int(), id: QuestionId, text: z.string(), played: z.boolean() })),
    }),
  ),
});
export type ControlView = z.infer<typeof ControlView>;

export const View = z.discriminatedUnion("role", [OutputView, PlayerView, HostView, ControlView]);
export type View = z.infer<typeof View>;
