import { CATEGORY_LABEL_FR, OWN_POINTS_FR, POINTS_SOURCE_FR, mechanicLabel, ruleSummary, unsupportedQuestion, type PointsSource, type Question, type Round } from "@quiz/schema";
import type { AnyMechanic, Registry } from "./mechanic.ts";
import { err, ok, type Rejection, type Result } from "./result.ts";
import { MIXED_CATEGORY } from "./mechanics/mixed/mixed.ts";

/** The mechanic scores by itself, never with the barème (fixed points: board, survey, allocation… ladder gains). */
const ownsPoints = (m: AnyMechanic): boolean => m.ownPoints === true || m.noStakes === true;

/** The mechanic that plays a question of a round, its parsed settings, the points rule that scores it and where it comes from. */
export type Played = { readonly mechanic: AnyMechanic; readonly config: unknown; readonly scoring: Round["scoring"]; readonly source: PointsSource };

/**
 * Resolves the mechanic of a round for one question: the round's own, or — mixed round (ADR-0015) — the one its
 * router picks for this question's answer kind. Every place that inits / scores / stakes a question uses it.
 */
export function playedBy(round: Pick<Round, "mechanic" | "mechanicConfig" | "scoring">, question: Question, registry: Registry): Result<Played, Rejection> {
  const m = registry.get(round.mechanic);
  if (m === null) return err("unsupported", `type de manche inconnu de cette version : ${mechanicLabel(round.mechanic)}`);
  const cfg = m.configSchema.safeParse(round.mechanicConfig);
  if (!cfg.success) return err("invalid", `réglages invalides pour la manche : ${cfg.error.issues.map((i) => i.message).join(" ; ")}`);
  if (m.route === undefined) return ok({ mechanic: m, config: cfg.data, scoring: question.scoring ?? round.scoring, source: ownsPoints(m) ? "own" : question.scoring !== undefined ? "question" : "round" });
  const target = m.route(cfg.data, question);
  const d = registry.get(target.id);
  if (d === null || d.route !== undefined) return err("unsupported", unsupportedQuestion(round.mechanic, question.answerSpec.kind));
  const dc = d.configSchema.safeParse(target.config);
  if (!dc.success) return err("invalid", `réglages invalides pour une question « ${mechanicLabel(d.id)} »`);
  // Points: the question's own rule, else its category's (mixed round), else the round's barème.
  const source: PointsSource = ownsPoints(d) ? "own" : question.scoring !== undefined ? "question" : target.scoring !== undefined ? "category" : "round";
  return ok({ mechanic: d, config: dc.data, scoring: question.scoring ?? target.scoring ?? round.scoring, source });
}

/** The points rule of a question: its own, else its category's (mixed round), else the round's. */
export function scoringOf(round: Round, question: Question | undefined, registry: Registry): Round["scoring"] {
  if (question === undefined) return round.scoring;
  const p = playedBy(round, question, registry);
  return p.ok ? p.value.scoring : (question.scoring ?? round.scoring);
}

/** What a question is worth, in words, and why (« 300 pts » · « barème de sa catégorie (QCM et vrai / faux) »). */
export type PointsInfo = { readonly summary: string; readonly source: PointsSource; readonly why: string };

export function pointsInfo(round: Round, question: Question, registry: Registry): PointsInfo {
  const p = playedBy(round, question, registry);
  if (!p.ok) return { summary: "—", source: "round", why: p.error.message };
  const { mechanic, scoring, source } = p.value;
  if (source === "own") return { summary: OWN_POINTS_FR[mechanic.id] ?? "points du jeu", source, why: POINTS_SOURCE_FR.own };
  const cat = round.mechanic === "mixed" ? CATEGORY_LABEL_FR[MIXED_CATEGORY[question.answerSpec.kind]] : undefined;
  const why = source === "category" && cat !== undefined ? `${POINTS_SOURCE_FR.category} (${cat})` : POINTS_SOURCE_FR[source];
  return { summary: ruleSummary(scoring), source, why };
}

