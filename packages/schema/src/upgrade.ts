import { PER_KIND_MECHANICS } from "./labels.ts";
import type { GameDocument } from "./session.ts";

/**
 * Rounds of a one-kind type (QCM, free text, survey…) become « Mixte » rounds with the same settings (ADR-0015):
 * the mixed round plays each question with that very mechanic and the same settings (every setting of these types
 * has its « Mixte » counterpart), so nothing changes on air. Pure and idempotent.
 * Applied when a game document is loaded (library, import), never to a journaled session (replay stays exact).
 */
export function toMixedRounds(game: GameDocument): GameDocument {
  if (!game.format.rounds.some((r) => PER_KIND_MECHANICS.has(r.mechanic))) return game;
  const rounds = game.format.rounds.map((r) => {
    if (!PER_KIND_MECHANICS.has(r.mechanic)) return r;
    const c: Record<string, unknown> = typeof r.mechanicConfig === "object" && r.mechanicConfig !== null && !Array.isArray(r.mechanicConfig) ? { ...r.mechanicConfig } : {};
    const cfg: Record<string, unknown> = {};
    if (typeof c["shuffleOptions"] === "boolean") cfg["shuffleOptions"] = c["shuffleOptions"];
    if (typeof c["allowChange"] === "boolean") cfg["allowChange"] = c["allowChange"];
    if (typeof c["maxStrikes"] === "number") cfg["pollMaxStrikes"] = c["maxStrikes"];
    if (r.mechanic === "poll-board" && typeof c["multiplier"] === "number" && c["multiplier"] !== 1) cfg["pollMultiplier"] = c["multiplier"];
    if (r.mechanic === "allocation" && c["keepOneEmpty"] === false) cfg["allocationKeepOneEmpty"] = false;
    if (r.mechanic === "number-answer" && (c["mode"] === "closest" || c["mode"] === "tolerance")) cfg["numberMode"] = c["mode"];
    return { ...r, mechanic: "mixed", mechanicConfig: cfg };
  });
  return { ...game, format: { ...game.format, rounds } };
}
