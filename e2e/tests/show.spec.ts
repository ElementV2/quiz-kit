import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

type Links = { entries: { id: string; path: string }[]; joinCode: string };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";

const controlToken = (): string => path("control").split("t=")[1] ?? "";

/** Each test starts its own game (tests share one server): the built-in QCM template. */
test.beforeEach(async ({ request }) => {
  expect((await request.post(`/api/games/g_e2e_qcm/launch?t=${controlToken()}&players=new`)).status()).toBe(200);
});

/** Fails the test on any console error / uncaught exception (e.g. an HTTPS-only API over plain HTTP). */
function watchErrors(page: Page, errors: string[]): void {
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") errors.push(`${page.url()} → ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${page.url()} → ${e.message}`));
}

test("a full question with control, output and two tablets over plain HTTP", async ({ browser }) => {
  const errors: string[] = [];
  const open = async (url: string, viewport?: { width: number; height: number }) => {
    const ctx = await browser.newContext(viewport === undefined ? {} : { viewport });
    const page = await ctx.newPage();
    watchErrors(page, errors);
    await page.goto(url);
    return page;
  };

  const control = await open(path("control"), { width: 1600, height: 1000 });
  await expect(control.getByText("connecté").first()).toBeVisible();
  expect(await control.evaluate(() => window.isSecureContext)).toBe(false); // really testing the HTTP path

  // Players from the control room (CSV paste).
  await control.getByText("Importer des joueurs").click();
  await control.locator(".c-csv textarea").fill("Ana;1\nBo;2");
  await control.getByRole("button", { name: "Importer", exact: true }).click();
  await expect(control.getByText("2 joueur(s) importé(s)")).toBeVisible();

  const output = await open(path("out-program"), { width: 1920, height: 1080 });
  const seat1 = await open(path("seat-1"), { width: 820, height: 1180 });
  const seat2 = await open(path("seat-2"), { width: 390, height: 844 });
  for (const s of [seat1, seat2]) {
    await s.getByText("Touchez l'écran pour commencer").click();
  }

  // Space = next step: start game, start round, present, open.
  for (let i = 0; i < 4; i++) {
    await control.locator("body").press("Space");
    await control.waitForTimeout(150);
  }
  await expect(output.locator(".q-zone-question")).toContainText("capitale de la France");
  await expect(seat1.getByRole("button", { name: /Paris/ })).toBeEnabled();

  await seat1.getByRole("button", { name: /Paris/ }).click();
  await seat2.getByRole("button", { name: /Lyon/ }).click();
  await expect(seat1.getByText("Réponse enregistrée")).toBeVisible();
  await expect(seat2.getByText("Réponse enregistrée")).toBeVisible();
  await expect(output.locator(".q-zone-answer-count")).toContainText("2");
  // No leak: before reveal, nothing on the output or the tablets marks the right answer.
  await expect(output.locator('.q-answer[data-state="correct"]')).toHaveCount(0);
  await expect(seat2.locator('.p-option[data-state="correct"]')).toHaveCount(0);
  await output.screenshot({ path: "screenshots/output-open.png" });
  await seat1.screenshot({ path: "screenshots/tablet-answered.png" });

  // Lock + reveal.
  await control.locator("body").press("Space");
  await control.waitForTimeout(150);
  await control.locator("body").press("Space");
  await expect(output.locator('.q-answer[data-state="correct"]')).toContainText("Paris");
  await expect(seat1.getByText("Bonne réponse")).toBeVisible();
  await expect(seat2.getByText("Raté")).toBeVisible();
  await output.screenshot({ path: "screenshots/output-revealed.png" });
  await control.screenshot({ path: "screenshots/control.png", fullPage: true });
  await seat2.screenshot({ path: "screenshots/phone-revealed.png" });

  // Checklist (its own tab): the real output counts, the control-room preview does not.
  await control.getByRole("tab", { name: /Check-list/ }).click();
  await expect(control.getByText(/1 sortie\(s\) connectée\(s\)/)).toBeVisible({ timeout: 8000 });
  await expect(control.getByText("2 siège(s) OK")).toBeVisible({ timeout: 8000 });

  // Reload the output mid-game: exact state back at once (e2e:output-reload, doc 05).
  await output.reload();
  await expect(output.locator('.q-answer[data-state="correct"]')).toContainText("Paris");

  expect(errors).toEqual([]);
});

test("a player joins with the game code over plain HTTP", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  watchErrors(page, errors);
  // The join code is per game: read the current one.
  const current = (await (await page.request.get(`/api/links?t=${controlToken()}`)).json()) as { joinCode: string }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own endpoint
  await page.goto(`/play?code=${current.joinCode}`);
  await page.getByLabel("Ton pseudo").fill("Zoé");
  await page.getByRole("button", { name: "C'est parti" }).click();
  await page.getByText("Touchez l'écran pour commencer").click();
  await expect(page.locator(".p-name")).toHaveText("Zoé · ce téléphone"); // same player, and it says where
  await page.reload(); // token kept in localStorage: same player after a reload
  await page.getByText("Touchez l'écran pour commencer").click();
  await expect(page.locator(".p-name")).toHaveText("Zoé · ce téléphone"); // same player, and it says where
  expect(errors).toEqual([]);
});
