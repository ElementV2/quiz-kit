import { z } from "zod";
import { Question } from "./content.ts";
import { Format } from "./format.ts";
import { ParticipantId, QuestionId, ScoreEntryId, SessionId, TeamId } from "./ids.ts";
import { Actor } from "./roles.ts";
import { Scene, Theme } from "./scenes.ts";

export const ParticipantStatus = z.enum(["active", "eliminated", "waiting", "substitute", "disconnected"]);
export type ParticipantStatus = z.infer<typeof ParticipantStatus>;

export const Channel = z.enum(["seat", "play", "buzzer", "twitch", "youtube"]);
export type Channel = z.infer<typeof Channel>;

/** Tolerant on purpose: journals written earlier must always read back. New names are cleaned at input (`cleanDisplayName`). */
export const DisplayName = z.string().trim().min(1).max(40);

/**
 * What a client-typed name becomes before entering the journal: no control characters, no bidi overrides /
 * isolates / marks (they could disguise a name on air). Joiners stay (ZWJ builds emojis like 👩‍🚀).
 */
export function cleanDisplayName(name: string): string {
  return name.replaceAll(/[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "").trim();
}

export const Participant = z.strictObject({
  id: ParticipantId,
  displayName: DisplayName,
  photo: z.string().optional(),
  teamId: TeamId.nullable(),
  seat: z.number().int().min(1).max(999).nullable(),
  status: ParticipantStatus,
  channel: Channel,
});
export type Participant = z.infer<typeof Participant>;

export const Team = z.strictObject({
  id: TeamId,
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  captainId: ParticipantId.nullable(),
});
export type Team = z.infer<typeof Team>;

export const ScoreTarget = z.union([
  z.strictObject({ participantId: ParticipantId }),
  z.strictObject({ teamId: TeamId }),
]);
export type ScoreTarget = z.infer<typeof ScoreTarget>;

export const ScoreReason = z.enum(["auto", "bonus", "penalty", "manual", "regrade"]);
export type ScoreReason = z.infer<typeof ScoreReason>;

export const ScoreEntry = z.strictObject({
  id: ScoreEntryId,
  target: ScoreTarget,
  /** Team of the participant when the entry was created (team totals never change retroactively). */
  teamId: TeamId.nullable(),
  delta: z.number().int(),
  questionId: QuestionId.nullable(),
  reason: ScoreReason,
  note: z.string().max(200).nullable(),
  by: Actor,
  at: z.number().int().nonnegative(),
  voided: z.boolean(),
});
export type ScoreEntry = z.infer<typeof ScoreEntry>;

/** Content + format frozen when the session starts (doc 02, `gameSnapshot`). */
export const GameDocument = z
  .strictObject({
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(200),
    questions: z.array(Question).min(1),
    format: Format,
    /** Look (doc 06): theme + output scenes. Optional: built-in presets are used when absent. */
    theme: Theme.optional(),
    scenes: z.array(Scene).default([]),
  })
  .superRefine((g, ctx) => {
    const ids = new Set(g.questions.map((q) => q.id));
    if (ids.size !== g.questions.length) ctx.addIssue({ code: "custom", message: "identifiants de questions en double" });
    for (const [ri, r] of g.format.rounds.entries()) {
      for (const qid of [...r.questions, ...r.reserve]) {
        if (!ids.has(qid)) {
          ctx.addIssue({ code: "custom", message: `manche ${ri} : question inconnue ${qid}`, path: ["format", "rounds", ri] });
        }
      }
    }
  });
export type GameDocument = z.infer<typeof GameDocument>;

export const Session = z.strictObject({
  schemaVersion: z.literal(1),
  id: SessionId,
  game: GameDocument,
  /** RNG seed (uint32). */
  seed: z.number().int().min(0).max(0xffff_ffff),
  createdAt: z.number().int().nonnegative(),
});
export type Session = z.infer<typeof Session>;
