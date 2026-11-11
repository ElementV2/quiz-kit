import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

/**
 * Several-answers QCM: the control room changes how it is counted after the reveal — on air, then from « Corriger » on
 * the question already played — and the player's points and result follow at once.
 */
test("control changes how a revealed several-answers QCM is counted: the player's points follow", async ({ browser, request }) => {
  expect((await request.post(`/api/games/g_e2e_multi/launch?t=${token("control")}&players=new`)).status()).toBe(200);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const control = await ctx.newPage();
  await control.goto(path("control"));
  await expect(control.getByText("connecté").first()).toBeVisible();
  await control.getByText("Importer des joueurs").click();
  await control.locator(".c-csv textarea").fill("Ana;1");
  await control.getByRole("button", { name: "Importer", exact: true }).click();
  const tabCtx = await browser.newContext({ viewport: { width: 800, height: 1000 }, hasTouch: true });
  const ana = await tabCtx.newPage();
  await ana.goto(path("seat-1"));
  await ana.getByText("Touchez l'écran pour commencer").click();
  const space = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await control.locator("body").press("Space");
      await control.waitForTimeout(200);
    }
  };
  await space(3); // start, round, present (answers open): « Lesquels sont des nombres premiers ? » (2 et 13)
  const picker = control.getByRole("group", { name: "Comptage des réponses multiples" });
  await expect(picker.getByText("tout ou rien — réglage de la catégorie", { exact: false })).toBeVisible();
  // Each way explained on this question (2 right answers out of 4).
  await expect(picker.getByText("1 bonne sur 2, 0 erreur → 50 %").first()).toBeVisible();
  await ana.locator(".p-option").first().click(); // « 2 » : one right answer of two
  await expect(control.locator(".q-mech-review li").filter({ hasText: "Ana" })).toBeVisible();
  await space(2); // lock, reveal
  await expect(ana.locator(".p-score")).toContainText("0 pts");

  // On air, after the reveal: partial points, wrong ticks deducted → 1 of 2 = 50 points, « En partie juste ».
  await picker.getByRole("radio", { name: /points partiels, erreurs déduites/ }).check();
  await expect(picker.getByText("choisi par la régie", { exact: false })).toBeVisible();
  await expect(ana.locator(".p-score")).toContainText("50 pts");
  await expect(ana.getByText("En partie juste")).toBeVisible();

  // The question already played (« Corriger »): right with one right answer and no wrong one → 100 points.
  await space(1); // next
  await control.locator(".c-q-row").first().getByRole("button", { name: "Corriger" }).click();
  const past = control.locator(".c-past").getByRole("group", { name: "Comptage des réponses multiples" });
  await past.getByRole("radio", { name: /juste dès une bonne réponse sans erreur/ }).check();
  await expect(ana.locator(".p-score")).toContainText("100 pts");
  // Back to the category's way: all or nothing again.
  await past.getByRole("button", { name: /Revenir au réglage/ }).click();
  await expect(ana.locator(".p-score")).toContainText("0 pts");
  await ctx.close();
  await tabCtx.close();
});
