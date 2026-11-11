import { z } from "zod";
import { AnswerSpec } from "./content.ts";
import { OptionId, ParticipantId, QuestionId, ScoreEntryId, TeamId } from "./ids.ts";
import type { Role } from "./roles.ts";
import { DisplayName, GameDocument, ParticipantStatus, ScoreTarget, Channel } from "./session.ts";

const action = <T extends string, S extends z.core.$ZodLooseShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), ...shape });

export const AnswerValue = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("choice"), optionIds: z.array(OptionId).min(1).max(6) }),
  z.strictObject({ kind: z.literal("text"), text: z.string().trim().min(1).max(200) }),
  z.strictObject({ kind: z.literal("number"), value: z.number() }),
  /** Full ordering of the shown options (order). */
  z.strictObject({ kind: z.literal("order"), optionIds: z.array(OptionId).min(2).max(8) }),
  /** left pair id → right pair id (pairs). */
  z.strictObject({ kind: z.literal("pairs"), matches: z.array(z.strictObject({ left: OptionId, right: OptionId })).min(1).max(8) }),
  /** Normalised point on the question image (pin). */
  z.strictObject({ kind: z.literal("pin"), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  /** Amount per option (allocation); the sum must equal the budget. */
  z.strictObject({ kind: z.literal("allocation"), amounts: z.array(z.strictObject({ optionId: OptionId, amount: z.number().int().min(0).max(10_000_000) })).min(1).max(6) }),
]);
export type AnswerValue = z.infer<typeof AnswerValue>;

export const JokerKind = z.enum(["fifty", "audience"]);
export type JokerKind = z.infer<typeof JokerKind>;

export const Action = z.discriminatedUnion("type", [
  // Flow (control)
  action("game.start", {}),
  action("round.start", { roundIndex: z.number().int().min(0).optional() }),
  action("question.present", { questionIndex: z.number().int().min(0).optional() }),
  action("question.open", {}),
  action("question.lock", {}),
  action("question.reveal", {}),
  action("question.next", {}),
  /**
   * Forces the verdict of one participant on one question (cheating, manual correction), whatever the mechanic:
   * `correct` true / false, or null = back to the automatic verdict. On air before the reveal it applies at the reveal;
   * once revealed (on air or played) that participant's points of the question are rewritten at once.
   */
  action("answer.verdict", {
    roundIndex: z.number().int().min(0),
    questionIndex: z.number().int().min(0),
    participantId: ParticipantId,
    correct: z.boolean().nullable(),
  }),
  /**
   * Between two questions: passes the upcoming one without playing it (e.g. a question this round cannot play).
   * Explicit target (from `BaseView.stakesTarget` / the next question): a duplicate press never passes a second one.
   */
  action("question.skip", { roundIndex: z.number().int().min(0), questionIndex: z.number().int().min(0) }),
  // Live corrections (doc 09)
  /**
   * Swaps a question of the current round for one of its reserve questions. Question on (presenting → judging):
   * the current one is replaced and presented again from scratch; phase idle: the question at `questionIndex`
   * (default: the next one). Refused once revealed (undo, or regrade).
   */
  action("question.replaceFromReserve", { reserveId: QuestionId, questionIndex: z.number().int().min(0).optional() }),
  /**
   * Live stakes (« cette question vaut 500 points », « ×5 ») for the question on air — or, between questions,
   * the next one. `points` replaces the round's base points (time decay scaled alike), `multiplier` multiplies
   * every point the question gives (rule and mechanic points). Both null = back to the round's rule.
   */
  action("question.setStakes", {
    /** Explicit target (from `BaseView.stakesTarget`): replay never has to guess which question was meant. */
    roundIndex: z.number().int().min(0),
    questionIndex: z.number().int().min(0),
    points: z.number().int().min(0).max(1_000_000).nullable(),
    multiplier: z.number().min(0.5).max(100).nullable(),
  }),
  /**
   * The live game edited in the studio (« Envoyer au direct »): the whole new document, applied if it does not break
   * what was played or what is on air (engine `livePatchProblem`). Journaled: replay applies it at the same point.
   */
  action("game.patch", {
    game: z.lazy(() => GameDocument),
    /** `gameVersion` the edit was made on: refused if the live game changed since (control-room corrections). */
    baseVersion: z.number().int().min(0),
  }),
  /** Fixes the text of the question on air (typo). */
  action("question.edit", { text: z.string().trim().min(1).max(2000) }),
  /**
   * Fixes the right answer of a question (same kind), then re-judges every reveal of it: their automatic points
   * are voided and rewritten (`reason: regrade`). Mechanics judged by a human (buzzer, board) cannot be regraded.
   */
  action("question.regrade", { questionId: QuestionId, answerSpec: AnswerSpec }),
  // Answers
  action("answer.submit", { participantId: ParticipantId, answer: AnswerValue }),
  /**
   * Operator verdict on an oral answer. `participantId` names who answered (buzzer: must hold the hand);
   * `optionId` names the matched option (poll-board: the slot found). Each mechanic says which it needs.
   */
  action("answer.judge", { participantId: ParticipantId.optional(), optionId: OptionId.optional(), correct: z.boolean() }),
  /** A player takes the hand (buzzer). Arrival order = journal order: the first journaled buzz wins. */
  action("buzz", { participantId: ParticipantId }),
  // Mechanic-specific controls (control)
  /** Reveals one masked element (poll-board slot) without awarding it. */
  action("element.reveal", { index: z.number().int().min(0).max(99) }),
  /** One-shot jokers (ladder): `fifty` hides two wrong options, `audience` draws an audience poll. */
  action("joker.use", { joker: JokerKind }),
  /** The ladder candidate walks away with the step reached. */
  action("ladder.stop", {}),
  /** Gives the hand to a team (poll-board). */
  /** Gives the hand to a team — or, in a game played individually, to a player (`participantId`). */
  action("poll.control", { teamId: TeamId.optional(), participantId: ParticipantId.optional() }),
  /** After the last strike, hands the steal attempt to another team (poll-board). */
  action("poll.steal", { teamId: TeamId.optional(), participantId: ParticipantId.optional() }),
  // Chain (« La chaîne », façon Maillon faible)
  /**
   * The player whose turn it is banks the chain (before their answer is judged): its value goes to the round bank and
   * the chain restarts at 0. `participantId` = the player on turn (the host / control room bank on their behalf).
   */
  action("chain.bank", { participantId: ParticipantId }),
  /** Ends the chain round now (its time is up, or the host stops it): the chain not banked is lost. */
  action("chain.end", {}),
  /** After a chain round: opens the elimination vote (every active player of the round votes). */
  action("chain.openVote", {}),
  /** A player votes against another active player of the round (not themselves); a new vote replaces theirs. */
  action("chain.vote", { participantId: ParticipantId, against: ParticipantId }),
  /** Closes the vote: most votes is eliminated; a tie is settled by the strongest link (`chain.pick`). */
  action("chain.closeVote", {}),
  /** Tie: the strongest link (`participantId`) picks who goes among the tied players (control may pick for them). */
  action("chain.pick", { participantId: ParticipantId, eliminated: ParticipantId }),
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
  /** Manual layers (doc 06 « TAKE / OUT ») : the control room puts a layer on air or takes it off. */
  action("layer.take", { layerId: z.string().regex(/^[0-9a-z-]+$/).max(64) }),
  action("layer.out", { layerId: z.string().regex(/^[0-9a-z-]+$/).max(64) }),
  action("team.add", {
    teamId: TeamId,
    name: z.string().trim().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  /**
   * The control room lets the host drive the flow from their tablet (pick, present, open, lock, reveal, skip,
   * hints, timer) — or takes it back. Journaled: who drove what stays in the journal.
   */
  action("host.setDrive", { enabled: z.boolean() }),
  /**
   * Chat votes (Twitch / YouTube), batched by the server's chat ingestion (one event per ~300 ms, not per message).
   * `userId` is the platform's id, prefixed by the channel (`tw:123`, `yt:UC…`): chat viewers are not participants.
   */
  action("crowd.tally", {
    votes: z.array(z.strictObject({ userId: z.string().regex(/^(tw|yt):[0-9A-Za-z_-]{1,64}$/), optionId: OptionId })).min(1).max(1000),
  }),
  // Undo (ADR-0010). The engine always journals the resolved `targetSeq`, so replay never guesses.
  action("undo", { targetSeq: z.number().int().min(1).optional() }),
]);
export type Action = z.infer<typeof Action>;
export type ActionType = Action["type"];
export type ActionOf<T extends ActionType> = Extract<Action, { type: T }>;

const CONTROL_ONLY: readonly ActionType[] = [
  "game.start", "round.start", "question.present", "question.open", "question.lock", "question.reveal",
  "question.next", "timer.set", "timer.stop", "player.add", "player.rename", "player.setStatus",
  "player.setTeam", "player.setSeat", "player.remove", "team.add", "undo", "layer.take", "layer.out",
  "element.reveal", "joker.use", "ladder.stop", "poll.control", "poll.steal", "question.replaceFromReserve", "question.edit",
  "host.setDrive", "question.setStakes", "game.patch", "question.skip", "chain.end", "chain.openVote", "chain.closeVote",
];

/**
 * What a host may do once the control room enabled `host.setDrive` (on top of `answer.judge`): the question flow
 * and the in-question tools — never scores, players, layers on air or undo (those stay with the control room).
 */
export const HOST_DRIVE_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "game.start", "round.start", "question.present", "question.open", "question.lock", "question.reveal", "question.next",
  "element.reveal", "timer.set", "timer.stop", "joker.use", "ladder.stop", "poll.control", "poll.steal", "question.setStakes", "question.skip",
  "chain.end", "chain.openVote", "chain.closeVote",
]);
const SCORING: readonly ActionType[] = ["score.adjust", "score.setTotal", "score.void", "question.regrade", "answer.verdict"];

/** What a player does from their tablet (or a seat): answer, buzz, bank the chain, vote, pick on a tied vote. */
const PLAYER_ACTIONS: readonly ActionType[] = ["answer.submit", "buzz", "chain.bank", "chain.vote", "chain.pick"];

/** Role → allowed actions (doc 01). Checked by the server AND the engine. */
export const actionPermissions: Readonly<Record<Role, ReadonlySet<ActionType>>> = {
  // Control may answer / buzz on behalf of a player (no tablet, operator-entered buzzer order).
  control: new Set<ActionType>([...CONTROL_ONLY, ...SCORING, ...PLAYER_ACTIONS, "answer.judge"]),
  "control-readonly": new Set<ActionType>(),
  scorer: new Set<ActionType>([...SCORING, "answer.judge"]),
  host: new Set<ActionType>(["answer.judge", "chain.bank"]),
  output: new Set<ActionType>(),
  player: new Set<ActionType>(PLAYER_ACTIONS),
  seat: new Set<ActionType>(PLAYER_ACTIONS),
  studio: new Set<ActionType>(),
  system: new Set<ActionType>(["timer.expired", "crowd.tally"]),
};

export function isAllowed(role: Role, type: ActionType): boolean {
  return actionPermissions[role].has(type);
}

/**
 * Actions that `undo` without target may cancel: everything except player answers (submit, buzz, chain vote) and undos.
 * `timer.expired` is included so that "undo" right after an auto-lock simply re-opens answers.
 */
export function isUndoableByDefault(type: ActionType): boolean {
  return type !== "answer.submit" && type !== "buzz" && type !== "chain.vote" && type !== "undo" && type !== "crowd.tally" && !NEVER_UNDONE.has(type);
}

/**
 * Never undone, even with an explicit target: undoing them would change, at replay, the permission under which
 * later events were accepted (review 3 B1: undoing `host.setDrive` erased everything the host had driven).
 * To change it back, send the opposite action.
 */
export const NEVER_UNDONE: ReadonlySet<ActionType> = new Set<ActionType>(["host.setDrive", "game.patch"]);

export function isNeverUndone(type: ActionType): boolean {
  return NEVER_UNDONE.has(type);
}
