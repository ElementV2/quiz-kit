import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { DEMO_GAME, DEMO_POLL_GAME, DEMO_TEXT_GAME, GameDocument } from "@quiz/schema";

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

/** One « Mixte » round: a QCM, a free text and a survey, played one after the other on the same tablet. */
const QUESTIONS = [DEMO_GAME.questions[0], DEMO_TEXT_GAME.questions[0], DEMO_POLL_GAME.questions[0]].flatMap((q) => (q === undefined ? [] : [q]));
const GAME = GameDocument.parse({
  ...DEMO_GAME,
  title: "Mixte e2e",
  questions: QUESTIONS,
  format: { ...DEMO_GAME.format, rounds: [{ ...DEMO_GAME.format.rounds[0], id: "r_mix", title: "Manche mixte", mechanic: "mixed", mechanicConfig: {}, questions: QUESTIONS.map((q) => q.id), reserve: [] }] },
});

test("mixed round: QCM, free text then survey in the same round — the tablet follows each kind", async ({ browser, request }) => {
  const t = token("control");
  expect((await request.put(`/api/games/g_mixed_e2e?t=${t}`, { data: { game: GAME } })).status()).toBe(200);
  expect((await request.post(`/api/games/g_mixed_e2e/launch?t=${t}&players=new`)).status()).toBe(200);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const control = await ctx.newPage();
  await control.goto(path("control"));
  await expect(control.getByText("connecté").first()).toBeVisible();
  await control.getByText("Importer des joueurs").click();
  await control.locator(".c-csv textarea").fill("Ana;1;Rouges");
  await control.getByRole("button", { name: "Importer", exact: true }).click();
  const phoneCtx = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true });
  const phone = await phoneCtx.newPage();
  await phone.goto(path("seat-1"));
  await phone.getByText("Touchez l'écran pour commencer").click();
  const space = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await control.locator("body").press("Space");
      await control.waitForTimeout(150);
    }
  };
  await expect(control.locator(".c-round-meta").first()).toContainText("Mixte");
  await space(3); // start, round, present (answers open): the QCM
  await expect(phone.locator(".p-option").first()).toBeVisible();
  await space(4); // lock, reveal, next, present → the free text
  await expect(phone.locator(".p-input")).toBeVisible();
  await phone.locator(".p-input").fill("van gogh");
  await phone.getByRole("button", { name: "Envoyer" }).click();
  await space(4); // lock, reveal, next, present → the survey
  await expect(control.getByText(/ne peut pas jouer/)).toHaveCount(0);
  await expect(phone.locator(".p-poll, .p-slot").first()).toBeVisible();
  await ctx.close();
  await phoneCtx.close();
});
