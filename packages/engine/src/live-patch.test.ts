import { describe, expect, it } from "vitest";
import { DEMO_BOARD_GAME, DEMO_EVENING_GAME, DEMO_GAME, type GameDocument, type Question } from "@quiz/schema";
import { createGame, replay } from "./game.ts";
import { defaultRegistry as reg } from "./index.ts";
import { project } from "./project.ts";
import { actor, addPlayers, answer, ctl, makeSession, run } from "./testing/harness.ts";

const clone = (g: GameDocument): GameDocument => structuredClone(g);
const extra: Question = { id: "q_new", prompt: { text: "Question ajoutée en direct ?" }, answerSpec: { kind: "boolean", correct: true }, hints: [], tags: [] };
const START = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(2), ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", "b"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })];

describe("game.patch (Envoyer au direct)", () => {
  it("adds a question and a round live; the control view, rundown and version follow; replay identical", () => {
    let g = run(reg, START, createGame(makeSession(DEMO_GAME)));
    const next = clone(g.state.game);
    next.questions.push(extra);
    next.format.rounds[0]?.questions.push("q_new");
    next.format.rounds.push({ ...next.format.rounds[0]!, id: "r_bonus", title: "Manche bonus", questions: ["q_new"] }); // oxlint-disable-line typescript/no-non-null-assertion -- fixture has a round
    next.title = "Démo modifiée";
    g = run(reg, [ctl({ type: "game.patch", baseVersion: 0, game: next })], g);
    const v = project(g, { role: "control" }, reg);
    if (v.role !== "control") throw new Error("control");
    expect(v.rundown[0]?.questions.at(-1)?.text).toBe("Question ajoutée en direct ?");
    expect(v.rundown.map((r) => r.title)).toContain("Manche bonus");
    expect(v).toMatchObject({ gameVersion: g.events.at(-1)?.seq, game: { title: "Démo modifiée", rounds: 2 } }); // version = seq of the send
    expect(v.studioPatchedAt).not.toBeNull();
    expect(replay(g.session, g.events, reg).state).toEqual(g.state);
  });

  it("refuses what would break the show: played question removed, on-air answer changed, played round moved, max below players", () => {
    const g = run(reg, START, createGame(makeSession(DEMO_GAME)));
    const removed = clone(g.state.game);
    removed.questions = removed.questions.filter((q) => q.id !== "q_capital_fr");
    removed.format.rounds[0]!.questions = removed.format.rounds[0]!.questions.filter((id) => id !== "q_capital_fr"); // oxlint-disable-line typescript/no-non-null-assertion -- fixture has a round
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: 0, game: removed })], g)).toThrow(/ne peut pas être supprimée/);
    const onAir = clone(g.state.game);
    const q0 = onAir.questions.find((q) => q.id === "q_capital_fr");
    if (q0?.answerSpec.kind === "single") q0.answerSpec.correct = "a";
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: 0, game: onAir })], g)).toThrow(/Corriger la réponse/);
    const few = clone(g.state.game);
    few.format.participants.max = 1;
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: 0, game: few })], g)).toThrow(/maximum/);
    const evening = run(reg, [ctl({ type: "game.start" }), ctl({ type: "round.start", roundIndex: 1 })], createGame(makeSession(DEMO_EVENING_GAME)));
    const moved = clone(evening.state.game);
    moved.format.rounds.reverse();
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: 0, game: moved })], evening)).toThrow(/rester à sa place/);
    expect(() => run(reg, [[actor("host", "h"), { type: "game.patch", baseVersion: 0, game: clone(g.state.game) }]], g)).toThrow(/forbidden/);
  });
});

describe("game.patch — review 7", () => {
  it("refuses a stale copy, a changed answer of a played question, a rescored played round, a new image on air; board grid frozen", () => {
    let g = run(reg, START, createGame(makeSession(DEMO_GAME)));
    const spec = g.state.game.questions[0]?.answerSpec;
    if (spec?.kind !== "single") throw new Error("fixture");
    g = run(reg, [ctl({ type: "question.regrade", questionId: "q_capital_fr", answerSpec: { ...spec, correct: "a" } })], g);
    const v1 = g.state.gameVersion;
    expect(v1).toBe(g.events.at(-1)?.seq); // control-room corrections bump the version (to their seq)
    const stale = clone(DEMO_GAME); // a studio copy made before the regrade
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: 0, game: stale })], g)).toThrow(/a changé depuis/);
    const changed = clone(g.state.game);
    const q = changed.questions.find((x) => x.id === "q_capital_fr");
    if (q?.answerSpec.kind === "single") q.answerSpec.correct = "b";
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: v1, game: changed })], g)).toThrow(/question jouée/);
    const rescored = clone(g.state.game);
    rescored.format.rounds[0]!.scoring = [{ type: "base", points: 1000 }]; // oxlint-disable-line typescript/no-non-null-assertion -- fixture has a round
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: v1, game: rescored })], g)).toThrow(/barème/);
    const onAir = run(reg, [ctl({ type: "question.next" }), ctl({ type: "question.present" })], g);
    const img = clone(onAir.state.game);
    const q2 = img.questions.find((x) => x.id === onAir.state.game.format.rounds[0]?.questions[1]);
    if (q2 !== undefined) q2.prompt.media = { hash: "a".repeat(64), mime: "image/png" };
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: v1, game: img })], onAir)).toThrow(/que par son texte/);
    const text = clone(onAir.state.game);
    const q3 = text.questions.find((x) => x.id === onAir.state.game.format.rounds[0]?.questions[1]);
    if (q3 !== undefined) q3.prompt.text = "Texte corrigé ?";
    expect(run(reg, [ctl({ type: "game.patch", baseVersion: v1, game: text })], onAir).state.gameVersion).toBeGreaterThan(v1);
    // never undone: send the previous document instead
    const patched = run(reg, [ctl({ type: "game.patch", baseVersion: v1, game: text })], onAir);
    expect(() => run(reg, [ctl({ type: "undo", targetSeq: patched.events.at(-1)?.seq ?? 0 })], patched)).toThrow(/forbidden/);
  });

  it("board in progress: the grid does not change", () => {
    const b = run(reg, [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(1), ctl({ type: "question.present", questionIndex: 2 })], createGame(makeSession(DEMO_BOARD_GAME)));
    const more = clone(b.state.game);
    more.questions.push({ ...extra, answerSpec: { kind: "oral", expected: "x" }, tags: ["Sciences"] });
    more.format.rounds[0]?.questions.push("q_new");
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: 0, game: more })], b)).toThrow(/grille ne change plus/);
  });
});

describe("game.patch — review 8", () => {
  it("undo never crosses a studio send (the send would replay on another state and vanish)", () => {
    let g = run(reg, START, createGame(makeSession(DEMO_GAME)));
    g = run(reg, [ctl({ type: "question.edit", text: "Capitale de la France ?" })], g);
    const next = clone(g.state.game);
    next.questions.push(extra);
    next.format.rounds[0]?.questions.push("q_new");
    g = run(reg, [ctl({ type: "game.patch", baseVersion: g.state.gameVersion, game: next })], g);
    expect(() => run(reg, [ctl({ type: "undo" })], g)).toThrow(/dernier envoi du studio/);
    const editSeq = g.events.find((e) => e.action.type === "question.edit")?.seq ?? 0;
    expect(() => run(reg, [ctl({ type: "undo", targetSeq: editSeq })], g)).toThrow(/dernier envoi du studio/);
    // after the send, undo works as usual
    const after = run(reg, [ctl({ type: "question.next" }), ctl({ type: "undo" })], g);
    expect(after.state.game.questions.some((q) => q.id === "q_new")).toBe(true);
  });

  it("versions are never reused: an undone correction then a new one is still a conflict for the old copy", () => {
    let g = run(reg, START, createGame(makeSession(DEMO_GAME)));
    g = run(reg, [ctl({ type: "question.edit", text: "A ?" })], g);
    const seen = g.state.gameVersion;
    g = run(reg, [ctl({ type: "undo" }), ctl({ type: "question.edit", text: "B ?" })], g);
    expect(g.state.gameVersion).not.toBe(seen);
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: seen, game: clone(g.state.game) })], g)).toThrow(/a changé depuis/);
  });

  it("refuses a played question media change, a mode switch with players, current round settings after its first question; drops displaced stakes", () => {
    const g = run(reg, START, createGame(makeSession(DEMO_GAME)));
    const base = g.state.gameVersion;
    const media = clone(g.state.game);
    const played = media.questions.find((q) => q.id === "q_capital_fr");
    if (played !== undefined) played.prompt.media = { hash: "b".repeat(64), mime: "image/png" };
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: base, game: media })], g)).toThrow(/ne change plus que par son texte/);
    const notes = clone(g.state.game);
    const n = notes.questions.find((q) => q.id === "q_capital_fr");
    if (n !== undefined) n.notes = "Nouvelle note animateur";
    expect(run(reg, [ctl({ type: "game.patch", baseVersion: base, game: notes })], g).state.game.questions.find((q) => q.id === "q_capital_fr")?.notes).toBe("Nouvelle note animateur");
    const cfg = clone(g.state.game);
    const r0 = cfg.format.rounds[0];
    if (r0 !== undefined) r0.mechanicConfig = { ...(r0.mechanicConfig as Record<string, unknown>), __changed: true }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- test: any change of the settings
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: base, game: cfg })], g)).toThrow(/réglages/);
    // stakes on the next question, then another question takes its place
    const staked = run(reg, [ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 1, points: null, multiplier: 3 })], g);
    const swap = clone(staked.state.game);
    swap.questions.push(extra);
    swap.format.rounds[0]?.questions.splice(1, 0, "q_new");
    const patched = run(reg, [ctl({ type: "game.patch", baseVersion: staked.state.gameVersion, game: swap })], staked);
    expect(patched.state.stakes).toBeNull();
  });
});

describe("game.patch — rounds already played keep their rules", () => {
  it("a round left (another one started) keeps its barème and settings: corrections score like the reveal did", () => {
    const two = clone(DEMO_GAME);
    const first = two.format.rounds[0];
    if (first === undefined) throw new Error("fixture");
    two.format.rounds.push({ ...first, id: "r_two", title: "Deuxième" });
    let g = run(reg, START, createGame(makeSession(two)));
    g = run(reg, [ctl({ type: "question.next" }), ctl({ type: "round.start", roundIndex: 1 })], g);
    const rules = clone(g.state.game);
    const r0 = rules.format.rounds[0];
    if (r0 === undefined) throw new Error("fixture");
    r0.mechanicConfig = { kinds: { choice: { scoring: [{ type: "base", points: 999 }] } } };
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: g.state.gameVersion, game: rules })], g)).toThrow(/déjà jouée/);
  });
});

