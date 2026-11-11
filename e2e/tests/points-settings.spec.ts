import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { GameDocument, type Question } from "@quiz/schema";

/**
 * Every points level set by hand in the studio, then played for real (control room + a tablet):
 * round barème (200), QCM category rule (300), one question's own fixed points (1000), a free-text question on the
 * round barème. A perfect player must end with 300 + 300 + 1000 + 200 = 1800.
 */

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

const qcm = (id: string, text: string): Question => ({
  id,
  prompt: { text },
  answerSpec: { kind: "single", options: [{ id: "a", label: "Un" }, { id: "b", label: "Deux" }, { id: "c", label: "Trois" }, { id: "d", label: "Quatre" }], correct: "b" },
  hints: [],
  tags: [],
});
const QUESTIONS: Question[] = [
  qcm("q_p1", "Première question QCM ?"),
  qcm("q_p2", "Deuxième question QCM ?"),
  qcm("q_p3", "Question à 1000 points ?"),
  { id: "q_p4", prompt: { text: "Capitale de la France ?" }, answerSpec: { kind: "text", accepted: ["Paris"] }, hints: [], tags: [] },
];
const GAME = GameDocument.parse({
  schemaVersion: 1,
  title: "E2E — points",
  questions: QUESTIONS,
  format: {
    id: "f_points",
    name: "Points",
    participants: { max: 50 },
    rounds: [{ id: "r_pts", title: "Manche points", mechanic: "mixed", mechanicConfig: {}, questions: QUESTIONS.map((q) => q.id), reserve: [], timer: { durationMs: 60_000, autoLock: false }, scoring: [{ type: "base", points: 100 }, { type: "timeDecay", minPoints: 50 }] }],
  },
  scenes: [],
});

async function setNumber(page: Page, input: ReturnType<Page["locator"]>, value: string): Promise<void> {
  await input.fill(value);
  await input.press("Tab");
  await expect(input).toHaveValue(value);
}

test("points by hand in the studio — round barème, category rule, one question's points — are the points scored live", async ({ browser, request }) => {
  const t = token("control");
  expect((await request.put(`/api/games/g_e2e_points?t=${t}`, { data: { game: GAME } })).status()).toBe(200);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const studio = await ctx.newPage();
  await studio.goto(path("studio"));
  await studio.locator(".s-game-open").filter({ hasText: /^E2E — points$/ }).click();
  await expect(studio.locator(".s-title")).toHaveValue("E2E — points");

  // 1. Round barème: 200 fixed (decay removed).
  await studio.getByRole("button", { name: "Format", exact: true }).click();
  const round = studio.locator(".s-round").first();
  const roundRule = round.locator(".s-section").filter({ hasText: "Barème de la manche" });
  await roundRule.locator(".s-score-row").nth(1).getByTitle("Retirer la règle").click();
  await expect(roundRule.locator(".s-score-row")).toHaveCount(1);
  await setNumber(studio, roundRule.locator(".s-score-row").first().locator("input"), "200");
  await round.screenshot({ path: "screenshots/points-round.png" });

  // 2. QCM category: its own rule, 300.
  const cat = round.locator(".s-cat").filter({ hasText: "QCM et vrai / faux" });
  await expect(cat).toHaveAttribute("open", ""); // used by the round: open
  await cat.getByText("Barème propre à cette catégorie").click();
  await setNumber(studio, cat.locator(".s-score-row").first().locator("input"), "300");

  // 3. One question's own points: 1000.
  await studio.getByRole("button", { name: "Contenu" }).click();
  const q3 = studio.locator(".s-table tbody tr").nth(2); // the third question (its text is in a textarea)
  await expect(q3.locator("textarea").first()).toHaveValue("Question à 1000 points ?");
  await q3.locator(".s-points select").selectOption("fixed");
  await setNumber(studio, q3.locator(".s-points input"), "1000");
  await studio.getByRole("button", { name: /^(Enregistr|Modifications|Non enregistré)/ }).click();
  await expect(studio.getByText("Enregistré", { exact: true }).first()).toBeVisible();

  // The saved document holds the three levels.
  const saved = GameDocument.parse(((await (await request.get(`/api/games/g_e2e_points?t=${t}`)).json()) as { game: unknown }).game); // oxlint-disable-line typescript/no-unsafe-type-assertion -- own endpoint
  expect(saved.format.rounds[0]?.scoring).toEqual([{ type: "base", points: 200 }]);
  expect(saved.format.rounds[0]?.mechanicConfig).toMatchObject({ kinds: { choice: { scoring: [{ type: "base", points: 300 }] } } });
  expect(saved.questions.find((q) => q.id === "q_p3")?.scoring).toEqual([{ type: "base", points: 1000 }]);

  // Played for real: control room + one tablet, every answer right.
  expect((await request.post(`/api/games/g_e2e_points/launch?t=${t}&players=new`)).status()).toBe(200);
  const control = await ctx.newPage();
  await control.goto(path("control"));
  await expect(control.getByText("connecté").first()).toBeVisible();
  await control.getByText("Importer des joueurs").click();
  await control.locator(".c-csv textarea").fill("Ana;1");
  await control.getByRole("button", { name: "Importer", exact: true }).click();
  const tabCtx = await browser.newContext({ viewport: { width: 800, height: 1280 }, hasTouch: true });
  const tablet = await tabCtx.newPage();
  await tablet.goto(path("seat-1"));
  await tablet.getByText("Touchez l'écran pour commencer").click();
  const space = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await control.locator("body").press("Space");
      await control.waitForTimeout(200);
    }
  };
  const expected = [300, 600, 1600];
  await space(2); // start, round
  for (const total of expected) {
    await space(1); // present (answers open)
    await tablet.locator(".p-option").filter({ hasText: "Deux" }).click();
    await expect(tablet.getByText("Réponse enregistrée").or(tablet.locator('.p-option[data-state="selected"]')).first()).toBeVisible();
    await space(3); // lock, reveal, next
    await expect(tablet.locator(".p-score")).toContainText(`${total} pts`);
  }
  await space(1); // present (answers open): the free text, on the round barème
  await tablet.locator(".p-input").fill("paris");
  await tablet.getByRole("button", { name: "Envoyer" }).click();
  await space(2); // lock, reveal
  await expect(tablet.locator(".p-score")).toContainText("1800 pts");
  await ctx.close();
  await tabCtx.close();
});
