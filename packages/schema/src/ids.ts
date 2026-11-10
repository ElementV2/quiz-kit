import { z } from "zod";

/** Prefixed identifiers (ADR-0011): `<prefix>_<body>`, body in [0-9A-Za-z_-]. */
const prefixed = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 2)
    .max(64)
    .regex(new RegExp(`^${prefix}_[0-9A-Za-z_-]+$`), `identifiant attendu au format ${prefix}_…`);

export const QuestionId = prefixed("q");
export const ParticipantId = prefixed("p");
export const TeamId = prefixed("t");
export const SessionId = prefixed("ses");
export const RoundId = prefixed("r");
export const FormatId = prefixed("f");
export const ScoreEntryId = prefixed("se");
export const ClientId = prefixed("c");

/** Option ids are local to a question (`a`, `b`, `opt_1`…). They become object keys in views: no prototype names. */
export const OptionId = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[0-9A-Za-z_-]+$/)
  .refine((s) => s !== "__proto__" && s !== "constructor" && s !== "prototype", "identifiant réservé");

export const MediaHash = z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 hexadécimal attendu");

export type QuestionId = z.infer<typeof QuestionId>;
export type ParticipantId = z.infer<typeof ParticipantId>;
export type TeamId = z.infer<typeof TeamId>;
export type SessionId = z.infer<typeof SessionId>;
export type RoundId = z.infer<typeof RoundId>;
export type FormatId = z.infer<typeof FormatId>;
export type ScoreEntryId = z.infer<typeof ScoreEntryId>;
export type ClientId = z.infer<typeof ClientId>;
export type OptionId = z.infer<typeof OptionId>;
export type MediaHash = z.infer<typeof MediaHash>;
