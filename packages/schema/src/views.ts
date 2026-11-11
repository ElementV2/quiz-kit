import { z } from "zod";
import { Phase } from "./phase.ts";
import { AnswerSpec, Media, NormRect } from "./content.ts";
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

/** Who plays a survey: a team (`t_…`), or a player (`p_…`) in a game played individually. */
export const PollSide = z.union([TeamId, ParticipantId]);

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
  /** Team that found it (per-answer scoring). */
  foundBy: PollSide.nullable().default(null),
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
  controllingTeamId: PollSide.nullable(),
  /** Team attempting the steal (null outside `steal` / before control designates it). */
  stealingTeamId: PollSide.nullable(),
  /** Sum of the values of found slots (public: those slots are revealed). */
  bank: z.number(),
  multiplier: z.number(),
  /** Team that takes the bank, once known (stage done). */
  winnerTeamId: PollSide.nullable(),
  /** `per-answer`: each team scores what it found (`teamPoints`); `bank`: the winner takes the bank. */
  scoring: z.enum(["per-answer", "bank"]).default("bank"),
  /** Per-answer scoring: points of each team on this question (× multiplier). */
  teamPoints: z.array(z.strictObject({ teamId: PollSide, points: z.number() })).default([]),
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

const OptionLite = z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() });

/** Free text answer with fuzzy matching (accents, case, punctuation, small typos). */
export const TextAnswerMechanicView = z.strictObject({
  mechanic: z.literal("text-answer"),
  /** SECRET: canonical answer, null for player / output until `revealed`. */
  correct: z.string().nullable(),
  answeredCount: z.number().int().nullable(),
  /** Host / control only: every answer with its automatic verdict, so the operator can overrule (`answer.judge`). */
  review: z.array(z.strictObject({ participantId: ParticipantId, text: z.string(), accepted: z.boolean(), overruled: z.boolean() })).nullable(),
});
export type TextAnswerMechanicView = z.infer<typeof TextAnswerMechanicView>;

export const NumberAnswerMechanicView = z.strictObject({
  mechanic: z.literal("number-answer"),
  /** `tolerance`: right within the tolerance; `closest`: the closest answer(s) win. */
  mode: z.enum(["tolerance", "closest"]),
  unit: z.string().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  /** SECRET until `revealed`. */
  correct: z.number().nullable(),
  tolerance: z.number().nullable(),
  answeredCount: z.number().int().nullable(),
  /** Closest answers first (top 10). Host / control from `locked`, outputs once revealed; null on tablets. */
  ranking: z.array(z.strictObject({ participantId: ParticipantId, value: z.number(), gap: z.number(), win: z.boolean() })).nullable(),
});
export type NumberAnswerMechanicView = z.infer<typeof NumberAnswerMechanicView>;

export const OrderMechanicView = z.strictObject({
  mechanic: z.literal("order"),
  /** Shown order (shuffled with the session seed, same for everyone). */
  options: z.array(OptionLite),
  /** SECRET: right order, until `revealed`. */
  correct: z.array(OptionId).nullable(),
  answeredCount: z.number().int().nullable(),
});
export type OrderMechanicView = z.infer<typeof OrderMechanicView>;

export const PairsMechanicView = z.strictObject({
  mechanic: z.literal("pairs"),
  left: z.array(z.strictObject({ id: OptionId, label: z.string() })),
  /** Shuffled, with anonymous ids (`r0`...): the id never tells the matching left item. */
  right: z.array(z.strictObject({ id: OptionId, label: z.string() })),
  /** SECRET until `revealed`. */
  correct: z.array(z.strictObject({ left: OptionId, right: OptionId })).nullable(),
  answeredCount: z.number().int().nullable(),
});
export type PairsMechanicView = z.infer<typeof PairsMechanicView>;

export const PinMechanicView = z.strictObject({
  mechanic: z.literal("pin"),
  image: Media.nullable(),
  /** SECRET: target zone until `revealed`. */
  correct: NormRect.nullable(),
  answeredCount: z.number().int().nullable(),
  /** Every pin, anonymous: host / control from `locked`, outputs once revealed; never sent to tablets (weight). */
  pins: z.array(z.strictObject({ x: z.number(), y: z.number(), hit: z.boolean() })).nullable(),
});
export type PinMechanicView = z.infer<typeof PinMechanicView>;

export const AllocationMechanicView = z.strictObject({
  mechanic: z.literal("allocation"),
  options: z.array(OptionLite),
  budget: z.number().int(),
  /** At least one option must stay empty (the tablet checks it before sending). */
  keepOneEmpty: z.boolean(),
  /** SECRET until `revealed`. */
  correct: OptionId.nullable(),
  /** Sum placed on each option: host / control from `locked`, everyone once revealed. */
  counts: z.record(OptionId, z.number().int()).nullable(),
  answeredCount: z.number().int().nullable(),
});
export type AllocationMechanicView = z.infer<typeof AllocationMechanicView>;

/** Jeopardy-like board: categories x values, control picks a cell, players buzz. */
export const BoardMechanicView = z.strictObject({
  mechanic: z.literal("board"),
  categories: z.array(z.strictObject({ name: z.string(), cells: z.array(z.strictObject({ questionIndex: z.number().int(), value: z.number().int(), played: z.boolean() })) })),
  /** Cell being played. */
  cell: z.strictObject({ questionIndex: z.number().int(), value: z.number().int(), category: z.string() }).nullable(),
  kind: z.enum(["oral", "single"]),
  options: z.array(OptionLite).nullable(),
  /** SECRET: right option label (`single`) or expected answer (`oral`), until `revealed`. */
  correct: z.string().nullable(),
  hand: ParticipantId.nullable(),
  winner: ParticipantId.nullable(),
  queue: z.array(ParticipantId).nullable(),
  lockedOut: z.array(ParticipantId).nullable(),
  me: z.strictObject({ hasHand: z.boolean(), queuePosition: z.number().int().min(1).nullable(), lockedOut: z.boolean(), canBuzz: z.boolean() }).nullable(),
});
export type BoardMechanicView = z.infer<typeof BoardMechanicView>;

/** Shared by hints and reveal-image: what the player types or picks. */
export const ProgressiveInput = z.enum(["text", "choice"]);

/** Decreasing hints: the earlier you answer, the more you score. */
export const HintsMechanicView = z.strictObject({
  mechanic: z.literal("hints"),
  /** Hints shown so far (the hidden ones never leave the server). */
  hints: z.array(z.string()),
  hintCount: z.number().int(),
  /** Number of hints of the question (public: only their texts are secret). */
  total: z.number().int(),
  /** Points for a right answer given now. */
  points: z.number().int(),
  input: ProgressiveInput,
  options: z.array(OptionLite).nullable(),
  /** SECRET: canonical text or right option id, until `revealed`. */
  correct: z.string().nullable(),
  answeredCount: z.number().int().nullable(),
});
export type HintsMechanicView = z.infer<typeof HintsMechanicView>;

/** Image revealed tile by tile: the earlier you answer, the more you score. */
export const RevealImageMechanicView = z.strictObject({
  mechanic: z.literal("reveal-image"),
  /** Null for players: the tablet must not get the full picture (it is shown masked on the outputs). */
  image: Media.nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
  /** Uncovered tiles (row-major index); everything once revealed. */
  revealed: z.array(z.number().int()),
  points: z.number().int(),
  input: ProgressiveInput,
  options: z.array(OptionLite).nullable(),
  /** SECRET until `revealed`. */
  correct: z.string().nullable(),
  answeredCount: z.number().int().nullable(),
});
export type RevealImageMechanicView = z.infer<typeof RevealImageMechanicView>;

/** The chat votes (Twitch / YouTube): majority wins. */
export const CrowdVoteMechanicView = z.strictObject({
  mechanic: z.literal("crowd-vote"),
  options: z.array(OptionLite),
  /** Votes per option: live when `showLive`, else host / control only until revealed. */
  counts: z.record(OptionId, z.number().int()).nullable(),
  /** Number of distinct voters (outputs / host / control; null on tablets: it changes ~3 times a second). */
  voters: z.number().int().nullable(),
  /** SECRET (when the question has a right answer) until revealed. */
  correct: OptionId.nullable(),
  /** Option(s) with the most votes, once revealed. */
  majority: z.array(OptionId).nullable(),
  /** Votes still accepted this long after the lock (stream delay), ms. */
  streamDelayMs: z.number().int(),
});
export type CrowdVoteMechanicView = z.infer<typeof CrowdVoteMechanicView>;

export const MechanicView = z.discriminatedUnion("mechanic", [
  ChoiceMechanicView, PollBoardMechanicView, BuzzerMechanicView, LadderMechanicView,
  TextAnswerMechanicView, NumberAnswerMechanicView, OrderMechanicView, PairsMechanicView, PinMechanicView,
  AllocationMechanicView, BoardMechanicView, HintsMechanicView, RevealImageMechanicView, CrowdVoteMechanicView,
]);
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
  /** Live stakes of the question on air (or the next one between questions): shown on air as « ×5 » / « 500 pts ». */
  stakes: z.strictObject({ points: z.number().int().nullable(), multiplier: z.number().nullable() }).nullable().default(null),
  /** Bumped by every live edit of the game (`game.patch`): screens refetch the look (theme, scenes) when it moves. */
  gameVersion: z.number().int().default(0),
  /**
   * Which question a `question.setStakes` sent now would target (the one on air, else the next one; null on a board
   * between cells — pick the cell first — or when no stakes are possible). `points` is false where the mechanic
   * decides its own points (board, poll-board, allocation, hints…): only a multiplier applies there.
   */
  stakesTarget: z.strictObject({ roundIndex: z.number().int(), questionIndex: z.number().int(), points: z.boolean() }).nullable().default(null),
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
  /**
   * The player's own accepted answer, null if none. Option ids for choice / order; otherwise the mechanic's
   * text form (`text`: [text], `number`: [value], `pairs`: ["left:right"], `pin`: ["x,y"], `allocation`: ["id:amount"]).
   */
  myAnswer: z.array(z.string().max(200)).nullable(),
  /** Only after reveal. */
  myResult: z.enum(["correct", "wrong", "none"]).nullable(),
  canAnswer: z.boolean(),
});
export type PlayerView = z.infer<typeof PlayerView>;

/** Run-down (doc 08): every round with its questions (status, answer, notes) and reserve — control / host only. */
export const Rundown = z.array(
    z.strictObject({
      index: z.number().int(),
      title: z.string(),
      mechanic: z.string(),
      questions: z.array(z.strictObject({
        index: z.number().int(),
        id: QuestionId,
        text: z.string(),
        played: z.boolean(),
        /** Control / host only (never in player / output views): to read ahead and correct (`question.regrade`). */
        answerSpec: AnswerSpec,
        /** Host notes of the question (control / host only). */
        notes: z.string().nullable(),
      })),
      /** Reserve questions of the round (`question.replaceFromReserve`). */
      reserve: z.array(z.strictObject({ id: QuestionId, text: z.string() })),
    }),
  );
export type Rundown = z.infer<typeof Rundown>;

export const HostView = BaseView.extend({
  role: z.literal("host"),
  notes: z.string().nullable(),
  nextQuestion: z.strictObject({ id: QuestionId, text: z.string() }).nullable(),
  /** The control room lets the host drive the question flow (`host.setDrive`). */
  drive: z.boolean(),
  /** Every question, to read ahead before anything is on air (and to pick one when driving). */
  rundown: Rundown,
  /** Current round / question position, even between questions (null before the first round). */
  cursor: z.strictObject({ roundIndex: z.number().int(), questionIndex: z.number().int().nullable() }).nullable(),
});
export type HostView = z.infer<typeof HostView>;

export const ControlView = BaseView.extend({
  role: z.literal("control"),
  readonly: z.boolean(),
  /** The host drives the question flow (`host.setDrive`). */
  hostDrives: z.boolean(),
  /** Last « Envoyer au direct » from the studio (server time), null if none. */
  studioPatchedAt: z.number().nullable().default(null),
  /** The live game: title and who may play (a full game refuses new players / seats). */
  game: z.strictObject({ title: z.string(), mode: z.enum(["solo", "teams", "crowd"]), minPlayers: z.number().int(), maxPlayers: z.number().int(), rounds: z.number().int() }),
  notes: z.string().nullable(),
  nextQuestion: z.strictObject({ id: QuestionId, text: z.string() }).nullable(),
  participants: z.array(Participant),
  teams: z.array(Team),
  ledger: z.array(ScoreEntry),
  /** Same text form as `PlayerView.myAnswer`. */
  answers: z.array(z.strictObject({ participantId: ParticipantId, optionIds: z.array(z.string().max(200)), at: z.number().int() })),
  /**
   * Question on air: each participant's automatic verdict (null: not judged yet / judged by a human) and the verdict
   * forced by the control room (`answer.verdict`, null: none). Participants who answered or were forced.
   */
  verdicts: z.array(z.strictObject({ participantId: ParticipantId, auto: z.boolean().nullable(), forced: z.boolean().nullable() })).default([]),
  /** Events ignored during the last replay because they became invalid after an undo (ADR-0010). */
  skipped: z.array(z.strictObject({ seq: z.number().int(), type: z.string(), reason: z.string() })),
  lastSeq: z.number().int(),
  /** Run-down (doc 08): every round and question with its status, for the control room's left column. */
  rundown: Rundown,
});
export type ControlView = z.infer<typeof ControlView>;

export const View = z.discriminatedUnion("role", [OutputView, PlayerView, HostView, ControlView]);
export type View = z.infer<typeof View>;
