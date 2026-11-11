import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

const contexts: BrowserContext[] = [];
// Tests share one server: close every page so the next test's presence checks start clean.
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

async function open(browser: Browser, url: string, viewport: { width: number; height: number }, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${url.split("?")[0]} → ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${url.split("?")[0]} → ${m.text()}`); });
  await page.goto(url);
  return page;
}

/** Launches a seeded template, adds players by CSV paste, gets tablets ready. */
async function setup(browser: Browser, request: APIRequestContext, template: string, players: string, seats: number, errors: string[]) {
  expect((await request.post(`/api/games/${template}/launch?t=${token("control")}`)).status()).toBe(200);
  const control = await open(browser, path("control"), { width: 1600, height: 1000 }, errors);
  await expect(control.getByText("connecté").first()).toBeVisible();
  await control.getByText("Importer des joueurs").click();
  await control.locator(".c-csv textarea").fill(players);
  await control.getByRole("button", { name: "Importer", exact: true }).click();
  await expect(control.getByText(/joueur\(s\) importé\(s\)/)).toBeVisible();
  const output = await open(browser, path("out-program"), { width: 1920, height: 1080 }, errors);
  const tablets: Page[] = [];
  for (let i = 1; i <= seats; i++) {
    const t = await open(browser, path(`seat-${i}`), { width: 600, height: 900 }, errors);
    await t.getByText("Touchez l'écran pour commencer").click();
    tablets.push(t);
  }
  const next = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await control.locator("body").press("Space");
      await control.waitForTimeout(120);
    }
  };
  return { control, output, tablets, next };
}

test("buzzer: first buzz gets the hand, the host / control judges, the output shows the winner", async ({ browser, request }) => {
  const errors: string[] = [];
  const { control, output, tablets, next } = await setup(browser, request, "g_modele_buzzer", "Ana;1\nBo;2", 2, errors);
  const [ana, bo] = tablets;
  if (ana === undefined || bo === undefined) throw new Error("tablets");
  await next(4); // start, round, present, open
  await expect(ana.getByRole("button", { name: "BUZZ" })).toBeEnabled();
  await ana.getByRole("button", { name: "BUZZ" }).click();
  await expect(ana.getByText("Vous avez la main")).toBeVisible();
  await bo.getByRole("button", { name: "BUZZ" }).click();
  await expect(bo.getByText("En file")).toBeVisible();
  await expect(output.locator(".q-zone-buzzer")).toContainText("Ana");
  // Never the answer on a tablet before the reveal.
  await expect(bo.getByText("Everest")).toHaveCount(0);
  await control.getByRole("button", { name: "✓ Bonne réponse" }).click();
  await expect(control.getByText("Ana a trouvé")).toBeVisible();
  await expect(ana.getByText("Bravo")).toBeVisible();
  await output.screenshot({ path: "screenshots/buzzer-output.png" });
  await ana.screenshot({ path: "screenshots/buzzer-tablet.png" });
  expect(errors).toEqual([]);
});

test("poll-board: hand to a team, found answers flip on the output, strikes, masked slots never leak", async ({ browser, request }) => {
  const errors: string[] = [];
  const { control, output, tablets, next } = await setup(browser, request, "g_modele_sondage", "Ana;1;Rouges\nBo;2;Bleus", 1, errors);
  await next(4);
  await control.locator(".q-mech select").selectOption({ label: "Rouges" });
  await control.getByRole("button", { name: "Donner la main" }).click();
  await expect(control.getByText("Main :")).toContainText("Rouges");
  // Before anything is found, the output and the tablets show no label.
  await expect(output.locator(".q-zone-poll-board")).not.toContainText("Banane");
  await expect(tablets[0]?.locator(".p-poll") ?? output.locator("x")).not.toContainText("Banane");
  await control.locator(".q-mech-slots li").filter({ hasText: "Banane" }).getByRole("button", { name: "✓ Trouvée" }).click();
  await expect(output.locator(".q-zone-poll-board")).toContainText("Banane");
  await expect(output.locator(".q-zone-poll-board")).not.toContainText("Pomme");
  await control.getByRole("button", { name: "✗ Mauvaise réponse" }).click();
  await expect(control.locator(".q-mech-strikes")).toContainText("✗");
  await output.screenshot({ path: "screenshots/poll-output.png" });
  expect(errors).toEqual([]);
});

test("ladder: the candidate climbs a step, 50:50 hides two answers on air", async ({ browser, request }) => {
  const errors: string[] = [];
  const { control, output, tablets, next } = await setup(browser, request, "g_modele_paliers", "Ana;1", 1, errors);
  const ana = tablets[0];
  if (ana === undefined) throw new Error("tablet");
  await next(4);
  await control.getByRole("button", { name: "50:50" }).click();
  await expect(output.locator('.q-answer[data-state="disabled"]')).toHaveCount(2);
  await ana.getByRole("button", { name: /8/ }).click();
  await expect(ana.getByText("Réponse enregistrée")).toBeVisible();
  await next(2); // lock, reveal
  await expect(output.locator('.q-answer[data-state="correct"]')).toContainText("8");
  await expect(output.locator(".q-zone-ladder")).toContainText("200");
  await output.screenshot({ path: "screenshots/ladder-output.png" });
  // « Je m'arrête »: our own dialog, never the browser's confirm() (a native dialog fails the test).
  control.on("dialog", (d) => {
    errors.push(`native dialog: ${d.message()}`);
    void d.dismiss();
  });
  await next(2); // next question, presented
  await control.getByRole("button", { name: "Je m'arrête" }).click();
  const dialog = control.getByRole("dialog");
  await expect(dialog).toContainText("Le candidat s'arrête ?");
  await dialog.getByRole("button", { name: "Annuler" }).click();
  await expect(dialog).toBeHidden();
  await control.getByRole("button", { name: "Je m'arrête" }).click();
  await dialog.getByRole("button", { name: "Il s'arrête" }).click();
  await expect(output.locator(".q-zone-ladder")).toContainText("200");
  expect(errors).toEqual([]);
});

test("effects layer: bench mode loads PixiJS lazily, renders frames, no console error", async ({ browser }) => {
  const errors: string[] = [];
  const out = await open(browser, `${path("out-program")}&fx=full&bench=1`, { width: 1920, height: 1080 }, errors);
  await expect(out.locator(".q-effects canvas")).toHaveCount(1);
  await expect(out.locator(".q-effects")).toContainText(/[1-9]\d* fps · effets full/, { timeout: 10_000 });
  await out.screenshot({ path: "screenshots/effects-bench.png" });
  const off = await open(browser, `${path("out-program")}&fx=off`, { width: 1920, height: 1080 }, errors);
  await expect(off.locator(".q-zone").first()).toBeVisible();
  await expect(off.locator(".q-effects")).toHaveCount(0);
  expect(errors).toEqual([]);
});
