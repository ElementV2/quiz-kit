import { mechanicLabel, unsupportedQuestion, type Question, type Round } from "@quiz/schema";
import type { AnyMechanic, Registry } from "./mechanic.ts";
import { err, ok, type Rejection, type Result } from "./result.ts";

/** The mechanic that plays a question of a round, its parsed settings and the points rule that scores it. */
export type Played = { readonly mechanic: AnyMechanic; readonly config: unknown; readonly scoring: Round["scoring"] };

/**
 * Resolves the mechanic of a round for one question: the round's own, or — mixed round (ADR-0015) — the one its
 * router picks for this question's answer kind. Every place that inits / scores / stakes a question uses it.
 */
export function playedBy(round: Pick<Round, "mechanic" | "mechanicConfig" | "scoring">, question: Question, registry: Registry): Result<Played, Rejection> {
  const m = registry.get(round.mechanic);
  if (m === null) return err("unsupported", `type de manche inconnu de cette version : ${mechanicLabel(round.mechanic)}`);
  const cfg = m.configSchema.safeParse(round.mechanicConfig);
  if (!cfg.success) return err("invalid", `réglages invalides pour la manche : ${cfg.error.issues.map((i) => i.message).join(" ; ")}`);
  if (m.route === undefined) return ok({ mechanic: m, config: cfg.data, scoring: question.scoring ?? round.scoring });
  const target = m.route(cfg.data, question);
  const d = registry.get(target.id);
  if (d === null || d.route !== undefined) return err("unsupported", unsupportedQuestion(round.mechanic, question.answerSpec.kind));
  const dc = d.configSchema.safeParse(target.config);
  if (!dc.success) return err("invalid", `réglages invalides pour une question « ${mechanicLabel(d.id)} »`);
  // Points: the question's own rule, else its category's (mixed round), else the round's barème.
  return ok({ mechanic: d, config: dc.data, scoring: question.scoring ?? target.scoring ?? round.scoring });
}

/** The points rule of a question: its own, else its category's (mixed round), else the round's. */
export function scoringOf(round: Round, question: Question | undefined, registry: Registry): Round["scoring"] {
  if (question === undefined) return round.scoring;
  const p = playedBy(round, question, registry);
  return p.ok ? p.value.scoring : (question.scoring ?? round.scoring);
}

