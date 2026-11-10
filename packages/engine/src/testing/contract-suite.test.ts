import { describe, expect, it } from "vitest";
import { DEMO_GAME, type Action, type View } from "@quiz/schema";
import { createRegistry, defineMechanic, type Mechanic } from "../mechanic.ts";
import { choice, type ChoiceConfig, type ChoiceState } from "../mechanics/choice/choice.ts";
import { assertContract } from "./contract-suite.ts";

/** Meta-tests: the contract suite must catch broken mechanics. */

type C = ChoiceConfig;
type S = ChoiceState;
// The registered mechanic is type-erased; recover the typed one to build faulty variants.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only: choice was defined with exactly these parameters
const typed = choice as unknown as Mechanic<C, S>;

/** fast-check wraps the failing assertion: read both the message and its cause. */
function failureOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return e instanceof Error ? `${e.message} ${String(e.cause)}` : String(e);
  }
  return "no failure";
}

const answerFor = (view: View, picks: readonly number[]): Action | null => {
  const m = view.mechanic;
  if (m === null) return null;
  const ids = [...new Set(picks.map((p) => m.options[p % m.options.length]?.id ?? "a"))].slice(0, m.maxPick);
  return { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ids } };
};

describe("mechanicContractSuite catches faulty mechanics", () => {
  it("a mechanic leaking the correct answer to players fails", () => {
    const leaky = defineMechanic<C, S>({ ...typed, project: (s, env) => ({ ...typed.project(s, { ...env, audience: "control" }) }) });
    const opts = { mechanic: leaky, registry: createRegistry([leaky]), game: DEMO_GAME, answerFor };
    expect(failureOf(() => assertContract(opts, 50))).toMatch(/leaked/);
  });

  it("a mechanic mutating its state fails", () => {
    const mutating = defineMechanic<C, S>({
      ...typed,
      submit: (s, participantId, answer, env) => {
        (s.answers as unknown[]).push({ participantId, optionIds: answer.optionIds, at: env.at }); // deliberate mutation
        return { ok: true, value: s };
      },
    });
    const opts = { mechanic: mutating, registry: createRegistry([mutating]), game: DEMO_GAME, answerFor };
    expect(failureOf(() => assertContract(opts, 50))).toMatch(/not extensible|read.only|frozen/i);
  });

  it("a non-deterministic mechanic fails the replay check", () => {
    let calls = 0;
    const flaky = defineMechanic<C, S>({ ...typed, judge: (s) => typed.judge(s).map((j) => ({ ...j, answeredAt: j.answeredAt + (calls++ % 2) * 5000 })) });
    const opts = { mechanic: flaky, registry: createRegistry([flaky]), game: DEMO_GAME, answerFor };
    expect(failureOf(() => assertContract(opts, 50))).toMatch(/replay differs/);
  });
});
