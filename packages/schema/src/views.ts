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

export const PollBoardSlot = z.strictObject({
  index: z.number().int().min(0),
  /** Shown to everyone (found by a team, or revealed by control with `element.reveal`). */
  revealed: z.boolean(),
  /** Found by a correct answer: its value counts in the bank. */
  found: z.boolean(),
  /** SECRET, same rule as `label`: the option to judge (`answer.judge { optionId }`) from the control room / host. */
  optionId: OptionId.nullable(),
  /** SECRET: null for player / output while the slot is masked. Host / control always see it. */
  label: z.string().nullable(),
  /** SECRET: share (%), same rule as `label`. */
  value: z.number().nullable(),
});
export type PollBoardSlot = z.infer<typeof PollBoardSlot>;

/** "Une famille en or": slots sorted by value (index 0 = top answer), strikes, hand and steal. */
export const PollBoardMechanicView = z.strictObject({
  mechanic: z.literal("poll-board"),
  slots: z.array(PollBoardSlot),
  strikes: z.number().int().min(0),
  maxStrikes: z.number().int().min(1),
  /** `play`: the team with the hand answers; `steal`: max strikes reached, another team may steal; `done`. */
  stage: z.enum(["play", "steal", "done"]),
  /** Team that has the hand (null until control gives it). */
  controllingTeamId: TeamId.nullable(),
  /** Team attempting the steal (null outside `steal` / before control designates it). */
  stealingTeamId: TeamId.nullable(),
  /** Sum of the values of found slots (public: those slots are revealed). */
  bank: z.number(),
  multiplier: z.number(),
  /** Team that takes the bank, once known (stage done). */
  winnerTeamId: TeamId.nullable(),
});
export type PollBoardMechanicView = z.infer<typeof PollBoardMechanicView>;

/** Buzzer (culture G): first journaled buzz takes the hand, the others queue; control / host judge. */
export const BuzzerMechanicView = z.strictObject({
  mechanic: z.literal("buzzer"),
  kind: z.enum(["oral", "single"]),
  /** Options read out by the host (`single`), shown to everyone; null for `oral`. */
  options: z.array(z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() })).nullable(),
  /** SECRET (`single`): null for player / output until `revealed`, always null for `oral`. */
  correct: OptionId.nullable(),
  /** SECRET (`oral`): expected answer, same rule as `correct`; always null for `single`. */
  expected: z.string().nullable(),
  /** Player who has the hand (head of the queue), null if nobody or once someone answered right. */
  hand: ParticipantId.nullable(),
  /** Player judged right: buzzers are closed for this question. */
  winner: ParticipantId.nullable(),
  /** Waiting players in buzz order (hand first). Null for players: tablet views stay light. */
  queue: z.array(ParticipantId).nullable(),
  /** Players locked out after a wrong answer. Null for players (see `me`). */
  lockedOut: z.array(ParticipantId).nullable(),
  /** The viewing player's own buzzer state; null for other audiences. `canBuzz` ignores the player's status (see `canAnswer`). */
  me: z
    .strictObject({
      hasHand: z.boolean(),
      /** 1 = has the hand; null when not waiting. */
      queuePosition: z.number().int().min(1).nullable(),
      lockedOut: z.boolean(),
      canBuzz: z.boolean(),
    })
    .nullable(),
});
export type BuzzerMechanicView = z.infer<typeof BuzzerMechanicView>;

export const LadderJokerState = z.enum(["available", "used", "disabled"]);
export type LadderJokerState = z.infer<typeof LadderJokerState>;

/** Ladder (QVGDM): one candidate climbs steps question after question; safe steps are kept on a fall. */
export const LadderMechanicView = z.strictObject({
  mechanic: z.literal("ladder"),
  options: z.array(z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() })),
  /** Options removed by the 50:50 joker (never the correct one). Public. */
  hidden: z.array(OptionId),
  /** Audience poll joker result, % per option (sums to 100, hidden options at 0). Public; null if not used. */
  audience: z.record(OptionId, z.number().int()).nullable(),
  /** SECRET: null for player / output until `revealed`. */
  correct: OptionId.nullable(),
  /** Amount of each step, increasing (index 0 = first step). */
  steps: z.array(z.number().int()),
  /** Indices of safe steps (kept after a wrong answer). */
  safeSteps: z.array(z.number().int()),
  /** Steps won so far; includes this question's result once revealed. */
  level: z.number().int().min(0),
  /** Index of the step played on this question; null once the ladder is over. */
  atStake: z.number().int().min(0).nullable(),
  /** Amount won so far (after a wrong answer: the secured amount). */
  gain: z.number().int(),
  /** Amount guaranteed whatever happens (last safe step reached). */
  secured: z.number().int(),
  candidate: ParticipantId.nullable(),
  /** The candidate's current answer (shown as the "final answer"). */
  answer: OptionId.nullable(),
  /** `lost` / `won` only once revealed; `stopped` as soon as control records `ladder.stop`. */
  status: z.enum(["playing", "stopped", "won", "lost"]),
  jokers: z.strictObject({ fifty: LadderJokerState, audience: LadderJokerState }),
});
export type LadderMechanicView = z.infer<typeof LadderMechanicView>;

export const MechanicView = z.discriminatedUnion("mechanic", [ChoiceMechanicView, PollBoardMechanicView, BuzzerMechanicView, LadderMechanicView]);
export type MechanicView = z.infer<typeof MechanicView>;

export const LeaderboardRow = z.strictObject({
  participantId: ParticipantId,
  displayName: z.string(),
  teamId: TeamId.nullable(),
  total: z.number().int(),
  rank: z.number().int().min(1),
});
export type LeaderboardRow = z.infer<typeof LeaderboardRow>;

export const TeamLeaderboardRow = z.strictObject({
  teamId: TeamId,
  name: z.string(),
  color: z.string(),
  total: z.number().int(),
  rank: z.number().int().min(1),
});
export type TeamLeaderboardRow = z.infer<typeof TeamLeaderboardRow>;

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
  /** Manual layers TAKEN by the control room (renderer: `manual` / `auto-hold` layers). */
  layers: z.record(z.string(), z.boolean()).default({}),
  /** Team totals (member points at scoring time + team entries, e.g. poll-board banks), ranked. Empty without teams. */
  teamBoard: z.array(TeamLeaderboardRow).default([]),
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
