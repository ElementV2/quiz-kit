export { ok, err, assertNever, type Result, type Rejection, type RejectionCode } from "./result.ts";
export { createRng, type Rng } from "./rng.ts";
export { GameState, TimerState, initialState, currentQuestion, currentRound, participantTotal, teamTotal } from "./state.ts";
export { createRegistry, defineMechanic, type Mechanic, type AnyMechanic, type Registry, type Audience, type Judgement, type MechanicEnv, type ProjectEnv, type RoundContext } from "./mechanic.ts";
export { pointsFor, roundHalfAway } from "./scoring.ts";
export { reduce, type Ctx } from "./reduce.ts";
export { createGame, decide, replay, nextSeq, CorruptJournalError, type Game, type Intent, type Skipped, type Snapshot } from "./game.ts";
export { project, leaderboard } from "./project.ts";
export { choice, ChoiceConfig, ChoiceState } from "./mechanics/choice/choice.ts";
export { pollBoard, PollBoardConfig, PollBoardState } from "./mechanics/poll-board/poll-board.ts";
export { buzzer, BuzzerConfig, BuzzerState } from "./mechanics/buzzer/buzzer.ts";

import { createRegistry } from "./mechanic.ts";
import { choice } from "./mechanics/choice/choice.ts";
import { pollBoard } from "./mechanics/poll-board/poll-board.ts";
import { buzzer } from "./mechanics/buzzer/buzzer.ts";

/** Mechanics available in this build. */
export const defaultRegistry = createRegistry([choice, pollBoard, buzzer]);
