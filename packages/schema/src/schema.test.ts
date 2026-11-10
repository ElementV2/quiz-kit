import { describe, expect, it } from "vitest";
import {
  Action,
  ScoringRule,
  AnswerSpec,
  DEMO_GAME,
  Event,
  GameDocument,
  QuestionId,
  Viewer,
  View,
  isAllowed,
  isUndoableByDefault,
  loadGameDocument,
  type Migration,
} from "./index.ts";

describe("ids", () => {
  it("accepts prefixed ids and rejects others", () => {
    expect(QuestionId.safeParse("q_01HZX").success).toBe(true);
    expect(QuestionId.safeParse("p_01HZX").success).toBe(false);
    expect(QuestionId.safeParse("q_").success).toBe(false);
    expect(QuestionId.safeParse("q_a b").success).toBe(false);
  });
});

describe("AnswerSpec", () => {
  const opts = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ];
  it.each([
    ["single", { kind: "single", options: opts, correct: "a" }],
    ["multi", { kind: "multi", options: opts, correct: ["a", "b"], minPick: 1, maxPick: 2 }],
    ["boolean", { kind: "boolean", correct: true }],
    ["poll", { kind: "poll", options: [{ id: "a", label: "Chat", value: 40 }] }],
    ["oral", { kind: "oral", expected: "Napoléon" }],
  ])("accepts a valid %s spec", (_k, spec) => {
    expect(AnswerSpec.safeParse(spec).success).toBe(true);
  });

  it.each([
    ["correct not among options", { kind: "single", options: opts, correct: "z" }],
    ["one option only", { kind: "single", options: [opts[0]], correct: "a" }],
    ["7 options", { kind: "single", options: "abcdefg".split("").map((id) => ({ id, label: id })), correct: "a" }],
    ["duplicate option ids", { kind: "single", options: [opts[0], opts[0]], correct: "a" }],
    ["multi unknown correct", { kind: "multi", options: opts, correct: ["z"] }],
    ["multi min > max", { kind: "multi", options: opts, correct: ["a"], minPick: 2, maxPick: 1 }],
    ["unknown kind", { kind: "telepathy" }],
    ["extra field (strict)", { kind: "boolean", correct: true, secret: 1 }],
  ])("rejects %s", (_k, spec) => {
    expect(AnswerSpec.safeParse(spec).success).toBe(false);
  });
});

describe("GameDocument", () => {
  it("accepts the demo game", () => {
    expect(GameDocument.safeParse(DEMO_GAME).success).toBe(true);
  });

  it("rejects a round referencing an unknown question", () => {
    const round = { ...DEMO_GAME.format.rounds[0], questions: ["q_missing"] };
    const bad = { ...DEMO_GAME, format: { ...DEMO_GAME.format, rounds: [round] } };
    const r = GameDocument.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects duplicate question ids", () => {
    const q = DEMO_GAME.questions[0];
    expect(GameDocument.safeParse({ ...DEMO_GAME, questions: [q, q] }).success).toBe(false);
  });
});

describe("loadGameDocument (versioning)", () => {
  it("loads the current version", () => {
    expect(loadGameDocument(DEMO_GAME).ok).toBe(true);
  });

  it("refuses a future version instead of guessing", () => {
    expect(loadGameDocument({ ...DEMO_GAME, schemaVersion: 99 })).toEqual({ ok: false, error: { code: "future-version", version: 99 } });
  });

  it("refuses a document without version", () => {
    const { schemaVersion: _v, ...rest } = DEMO_GAME;
    expect(loadGameDocument(rest)).toEqual({ ok: false, error: { code: "missing-version" } });
  });

  it("applies migrations in order up to the current version", () => {
    // Simulates a historic v0 where the title was called `name`.
    const v0toV1: Migration = {
      from: 0,
      migrate: ({ name, ...rest }) => ({ ...rest, title: name }),
    };
    const { title, ...rest } = DEMO_GAME;
    const r = loadGameDocument({ ...rest, name: title, schemaVersion: 0 }, [v0toV1]);
    expect(r.ok && r.value.title).toBe(title);
  });

  it("reports a missing migration", () => {
    expect(loadGameDocument({ ...DEMO_GAME, schemaVersion: 0 }, [])).toEqual({ ok: false, error: { code: "missing-migration", from: 0 } });
  });

  it("reports validation issues with their path", () => {
    const r = loadGameDocument({ ...DEMO_GAME, title: "" });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid", issues: [expect.stringMatching(/^title/)] } });
  });
});

describe("Action", () => {
  it("parses a valid answer and applies defaults", () => {
    const a = Action.parse({ type: "score.adjust", target: { participantId: "p_1" }, delta: 10 });
    expect(a).toMatchObject({ type: "score.adjust", reason: "manual" });
  });

  it.each([
    { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: [] } },
    { type: "answer.submit", participantId: "x", answer: { kind: "choice", optionIds: ["a"] } },
    { type: "question.open", extra: true },
    { type: "rm -rf" },
    { type: "score.adjust", target: { participantId: "p_1" }, delta: 1.5 },
  ])("rejects malformed action %#", (a) => {
    expect(Action.safeParse(a).success).toBe(false);
  });
});

describe("permissions", () => {
  it("players can only answer", () => {
    expect(isAllowed("player", "answer.submit")).toBe(true);
    expect(isAllowed("player", "question.reveal")).toBe(false);
    expect(isAllowed("player", "score.adjust")).toBe(false);
    expect(isAllowed("seat", "undo")).toBe(false);
  });
  it("read-only roles cannot act", () => {
    expect(isAllowed("control-readonly", "question.open")).toBe(false);
    expect(isAllowed("output", "answer.submit")).toBe(false);
  });
  it("only the system injects timer expirations", () => {
    expect(isAllowed("control", "timer.expired")).toBe(false);
    expect(isAllowed("system", "timer.expired")).toBe(true);
  });
  it("undo never targets player answers by default", () => {
    expect(isUndoableByDefault("answer.submit")).toBe(false);
    expect(isUndoableByDefault("score.adjust")).toBe(true);
    expect(isUndoableByDefault("timer.expired")).toBe(true);
  });
});

describe("ScoringRule", () => {
  it("rejects a decay that would raise points over time, or two decays", () => {
    expect(ScoringRule.safeParse([{ type: "base", points: 10 }, { type: "timeDecay", minPoints: 20 }]).success).toBe(false);
    expect(ScoringRule.safeParse([{ type: "base", points: 10 }, { type: "timeDecay", minPoints: 1 }, { type: "timeDecay", minPoints: 2 }]).success).toBe(false);
    expect(ScoringRule.safeParse([{ type: "base", points: 10 }, { type: "timeDecay", minPoints: 5 }]).success).toBe(true);
  });
});

describe("Event / Viewer / View", () => {
  it("parses an event", () => {
    expect(
      Event.safeParse({ seq: 1, at: 1, actor: { role: "control" }, action: { type: "game.start" }, idempotencyKey: null }).success,
    ).toBe(true);
  });
  it("parses viewers", () => {
    expect(Viewer.safeParse({ role: "seat", seat: 3 }).success).toBe(true);
    expect(Viewer.safeParse({ role: "player" }).success).toBe(false);
  });
  it("rejects a player view carrying host notes (strict)", () => {
    const base = {
      role: "player", sessionId: "ses_1", phase: "lobby", round: null, question: null, timer: null, mechanic: null,
      leaderboard: [], me: null, myAnswer: null, myResult: null, canAnswer: false,
    };
    expect(View.safeParse(base).success).toBe(true);
    expect(View.safeParse({ ...base, notes: "secret" }).success).toBe(false);
  });
});
