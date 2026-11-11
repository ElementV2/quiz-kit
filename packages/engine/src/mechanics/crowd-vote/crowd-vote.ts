import { z } from "zod";
import { Media, OptionId, TeamId, type CrowdVoteMechanicView } from "@quiz/schema";
import { defineMechanic, type Judgement } from "../../mechanic.ts";
import { err, ok } from "../../result.ts";
import { isPrivileged } from "../shared/answers.ts";

/**
 * Chat majority (doc 03 `crowd-vote`): Twitch / YouTube viewers vote for an option (`crowd.tally`, batched by
 * the server). One vote per viewer; a later vote replaces the earlier one while voting is open. Votes still count
 * `streamDelayMs` after the lock: the stream reaches viewers late (doc 04 `streamDelayMs`). Majority wins; with
 * a `single` question and a `teamId`, the team (e.g. « Le chat ») scores `points` when the majority is right.
 * Works with `single` (right answer known) and `poll` (opinion, no right answer) questions.
 */

export const CrowdVoteConfig = z.strictObject({
  streamDelayMs: z.number().int().min(0).max(60_000).default(0),
  /** Live distribution on air (default) or hidden until the reveal. */
  showLive: z.boolean().default(true),
  /** Team credited when the chat majority is right (fixed points). */
  teamId: TeamId.optional(),
  points: z.number().int().min(0).max(1_000_000).default(0),
});
export type CrowdVoteConfig = z.infer<typeof CrowdVoteConfig>;

export const CrowdVoteState = z.strictObject({
  options: z.array(z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() })),
  correct: OptionId.nullable(),
  streamDelayMs: z.number().int(),
  showLive: z.boolean(),
  teamId: TeamId.nullable(),
  points: z.number().int(),
  /** userId → option, insertion order kept (deterministic). */
  votes: z.array(z.strictObject({ userId: z.string(), optionId: OptionId })),
  /** Set when the state is compacted for the reveal history: counts kept, the per-viewer votes dropped. */
  frozen: z.strictObject({ counts: z.record(OptionId, z.number().int()), voters: z.number().int() }).nullable().default(null),
});
export type CrowdVoteState = z.infer<typeof CrowdVoteState>;

type S = CrowdVoteState;

const lite = (o: { id: string; label: string; media?: z.infer<typeof Media> | undefined }) => (o.media ? { id: o.id, label: o.label, media: o.media } : { id: o.id, label: o.label });

const countsCache = new WeakMap<S, Record<string, number>>();
function countsOf(s: S): Record<string, number> {
  if (s.frozen !== null) return s.frozen.counts;
  let c = countsCache.get(s);
  if (c === undefined) {
    const sums: Record<string, number> = Object.fromEntries(s.options.map((o) => [o.id, 0]));
    for (const v of s.votes) sums[v.optionId] = (sums[v.optionId] ?? 0) + 1;
    c = sums;
    countsCache.set(s, c);
  }
  return c;
}

const votersOf = (s: S): number => s.frozen?.voters ?? s.votes.length;

function majorityOf(s: S): string[] {
  const c = countsOf(s);
  const best = Math.max(0, ...Object.values(c));
  return best === 0 ? [] : s.options.filter((o) => (c[o.id] ?? 0) === best).map((o) => o.id);
}

export const crowdVote = defineMechanic<CrowdVoteConfig, CrowdVoteState>({
  id: "crowd-vote",
  configSchema: CrowdVoteConfig,
  stateSchema: CrowdVoteState,

  init(cfg, question) {
    const a = question.answerSpec;
    const common = { streamDelayMs: cfg.streamDelayMs, showLive: cfg.showLive, teamId: cfg.teamId ?? null, points: cfg.points, votes: [] };
    if (a.kind === "single") return ok({ options: a.options.map(lite), correct: a.correct, frozen: null, ...common });
    if (a.kind === "poll") return ok({ options: a.options.map(lite), correct: null, frozen: null, ...common });
    return err("unsupported", `la mécanique crowd-vote ne gère que les questions single ou poll (reçu ${a.kind})`);
  },

  submit() {
    return err("unsupported", "vote du chat : les tablettes ne votent pas ici");
  },

  onAction(s, a, env) {
    if (a.type !== "crowd.tally") return null;
    const inDelay = (env.phase === "locked" || env.phase === "judging") && env.lockedAt !== undefined && env.lockedAt !== null && env.at - env.lockedAt <= s.streamDelayMs;
    if (env.phase !== "open" && !inDelay) return err("wrong-phase", "vote du chat fermé");
    const known = new Set(s.options.map((o) => o.id));
    const latest = new Map(s.votes.map((v) => [v.userId, v.optionId]));
    for (const v of a.votes) if (known.has(v.optionId)) latest.set(v.userId, v.optionId);
    return ok({ ...s, votes: [...latest].map(([userId, optionId]) => ({ userId, optionId })) });
  },

  judge(s): Judgement[] {
    if (s.teamId === null || s.correct === null || s.points === 0) return [];
    const m = majorityOf(s);
    if (m.length === 0) return [];
    const right = m.length === 1 && m[0] === s.correct;
    return [{ kind: "fixed", target: { teamId: s.teamId }, outcome: right ? "correct" : "wrong", points: right ? s.points : 0 }];
  },

  // History keeps the counts, not tens of thousands of viewer ids (snapshot size, review 3 m3).
  compact: (s) => ({ ...s, votes: [], frozen: { counts: { ...countsOf(s) }, voters: votersOf(s) } }),

  endsRound: () => false,
  closeRound: () => [],
  removeParticipant: (s) => s,
  answerOf: () => null,
  answers: () => [],

  regrade(s, question) {
    const a = question.answerSpec;
    if (a.kind !== "single" || !s.options.some((o) => o.id === a.correct)) return err("invalid", "la bonne réponse doit être une des propositions");
    return ok({ ...s, correct: a.correct });
  },

  project(s, env): CrowdVoteMechanicView {
    const revealed = env.phase === "revealed";
    const live = s.showLive || revealed || isPrivileged(env.audience);
    return {
      mechanic: "crowd-vote",
      options: s.options.map((o) => ({ ...o })),
      // Tablets do not need the chat distribution (and it changes every 300 ms).
      counts: env.audience !== "player" && live ? countsOf(s) : null,
      voters: env.audience === "player" ? null : votersOf(s),
      correct: revealed || isPrivileged(env.audience) ? s.correct : null,
      majority: revealed ? majorityOf(s) : null,
      streamDelayMs: s.streamDelayMs,
    };
  },
});
