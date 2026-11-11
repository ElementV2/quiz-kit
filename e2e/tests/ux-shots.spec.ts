import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

/** UX captures (e2e/screenshots/ux-*.png): control room, host and every tablet input, at the target sizes. */

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

async function open(browser: Browser, url: string, viewport: { width: number; height: number }, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 1000 });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${url.split("?")[0]} → ${e.message}`));
  await page.goto(url);
  return page;
}

async function setup(browser: Browser, request: APIRequestContext, template: string, players: string, errors: string[], control = { width: 1366, height: 768 }) {
  expect((await request.post(`/api/games/${template}/launch?t=${token("control")}`)).status()).toBe(200);
  const c = await open(browser, path("control"), control, errors);
  await expect(c.getByText("connecté").first()).toBeVisible();
  await c.getByText("Importer des joueurs").click();
  await c.locator(".c-csv textarea").fill(players);
  await c.getByRole("button", { name: "Importer", exact: true }).click();
  await expect(c.getByText(/joueur\(s\) importé\(s\)/)).toBeVisible();
  const next = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await c.locator("body").press("Space");
      await c.waitForTimeout(150);
    }
  };
  return { control: c, next };
}

async function seat(browser: Browser, n: number, viewport: { width: number; height: number }, errors: string[]): Promise<Page> {
  const t = await open(browser, path(`seat-${n}`), viewport, errors);
  await t.getByText("Touchez l'écran pour commencer").click();
  return t;
}

const PHONE = { width: 360, height: 640 };
const TABLET = { width: 800, height: 1280 };

test("control room at 1366×768 and 1920×1080, host and tablets on a QCM", async ({ browser, request }) => {
  const errors: string[] = [];
  const { control, next } = await setup(browser, request, "g_e2e_qcm", "Ana;1;Rouges\nBo;2;Bleus\nChloé;3;Rouges\nDidier;4;Bleus", errors);
  const output = await open(browser, path("out-program"), { width: 1920, height: 1080 }, errors);
  const phone = await seat(browser, 1, PHONE, errors);
  const tablet = await seat(browser, 2, TABLET, errors);
  await phone.screenshot({ path: "screenshots/ux-player-phone-waiting.png" });
  await next(4);
  await expect(phone.getByRole("button", { name: /Paris/ })).toBeEnabled();
  await phone.screenshot({ path: "screenshots/ux-player-phone-choice.png" });
  await tablet.screenshot({ path: "screenshots/ux-player-tablet-choice.png" });
  await phone.getByRole("button", { name: /Paris/ }).click();
  await expect(phone.getByText("Réponse enregistrée")).toBeVisible();
  await phone.screenshot({ path: "screenshots/ux-player-phone-answered.png" });
  await tablet.getByRole("button", { name: /Lyon/ }).click();
  await expect(output.locator(".q-zone-question")).toBeVisible();
  await control.waitForTimeout(400);
  // The critical controls fit without scrolling at 1366×768.
  for (const name of [/Fermer les réponses/, /Annuler/]) await expect(control.getByRole("button", { name })).toBeInViewport();
  await control.screenshot({ path: "screenshots/ux-control-1366.png" });
  await control.setViewportSize({ width: 1920, height: 1080 });
  await control.waitForTimeout(400);
  await control.screenshot({ path: "screenshots/ux-control-1920.png" });
  await control.getByRole("tab", { name: /Outils/ }).click();
  await control.getByText("Buzzers clavier (USB)").click();
  await control.screenshot({ path: "screenshots/ux-control-tools.png" });
  await control.setViewportSize({ width: 1366, height: 768 });
  await next(2);
  await expect(phone.getByText("Bonne réponse")).toBeVisible();
  await phone.screenshot({ path: "screenshots/ux-player-phone-revealed.png" });
  await tablet.screenshot({ path: "screenshots/ux-player-tablet-revealed.png" });
  expect(errors).toEqual([]);
});

test("buzzer: host judges the hand, tablets show the states", async ({ browser, request }) => {
  const errors: string[] = [];
  const { next } = await setup(browser, request, "g_modele_buzzer", "Ana;1\nBo;2", errors);
  const host = await open(browser, path("host"), { width: 1280, height: 800 }, errors);
  const ana = await seat(browser, 1, PHONE, errors);
  const bo = await seat(browser, 2, PHONE, errors);
  await next(4);
  await expect(ana.getByRole("button", { name: "BUZZ" })).toBeEnabled();
  await ana.screenshot({ path: "screenshots/ux-player-phone-buzzer.png" });
  await ana.getByRole("button", { name: "BUZZ" }).click();
  await bo.getByRole("button", { name: "BUZZ" }).click();
  await expect(host.locator(".h-hand")).toHaveText("Ana");
  await host.screenshot({ path: "screenshots/ux-host-buzzer.png" });
  await ana.screenshot({ path: "screenshots/ux-player-phone-buzzer-hand.png" });
  await host.getByRole("button", { name: "✓ Bonne réponse" }).click();
  await expect(ana.getByText("Bravo")).toBeVisible();
  expect(errors).toEqual([]);
});

test("text answer: host overrules from the tablet", async ({ browser, request }) => {
  const errors: string[] = [];
  const { next } = await setup(browser, request, "g_e2e_texte", "Ana;1\nBo;2", errors);
  const host = await open(browser, path("host"), { width: 1280, height: 800 }, errors);
  const ana = await seat(browser, 1, PHONE, errors);
  const bo = await seat(browser, 2, PHONE, errors);
  await next(4);
  await ana.screenshot({ path: "screenshots/ux-player-phone-text.png" });
  await ana.locator(".p-input").fill("van gogh");
  await ana.getByRole("button", { name: "Envoyer" }).click();
  await bo.locator(".p-input").fill("Monet");
  await bo.getByRole("button", { name: "Envoyer" }).click();
  await expect(host.locator(".h-review li")).toHaveCount(2);
  await host.screenshot({ path: "screenshots/ux-host-text-review.png" });
  expect(errors).toEqual([]);
});

for (const [template, name] of [["g_e2e_estimation", "number"], ["g_e2e_ordre", "order"], ["g_e2e_paires", "pairs"], ["g_e2e_repartition", "allocation"], ["g_modele_indices", "hints"], ["g_modele_sondage", "poll"]] as const) {
  test(`tablet input: ${name}`, async ({ browser, request }) => {
    const errors: string[] = [];
    const { next } = await setup(browser, request, template, "Ana;1;Rouges\nBo;2;Bleus", errors);
    const phone = await seat(browser, 1, PHONE, errors);
    const tablet = await seat(browser, 2, TABLET, errors);
    await next(4);
    await phone.waitForTimeout(400);
    await phone.screenshot({ path: `screenshots/ux-player-phone-${name}.png` });
    await tablet.screenshot({ path: `screenshots/ux-player-tablet-${name}.png` });
    if (name === "poll") {
      const host = await open(browser, path("host"), { width: 1280, height: 800 }, errors);
      await expect(host.locator(".h-slots li").first()).toBeVisible();
      await host.screenshot({ path: "screenshots/ux-host-poll.png" });
    }
    expect(errors).toEqual([]);
  });
}

test("responsive: host on a portrait tablet and a phone, tablets in landscape, home page on a phone — nothing overflows", async ({ browser, request }) => {
  const errors: string[] = [];
  const { control, next } = await setup(browser, request, "g_e2e_qcm", "Ana;1;Rouges\nBo;2;Bleus", errors);
  await control.getByRole("switch", { name: "L'animateur pilote" }).click();
  const sizes = { "host-tablet-portrait": { width: 800, height: 1280 }, "host-phone": { width: 390, height: 844 } } as const;
  const hosts = await Promise.all(Object.values(sizes).map((vp) => open(browser, path("host"), vp, errors)));
  const tabletLand = await seat(browser, 1, { width: 1024, height: 768 }, errors);
  const phoneLand = await seat(browser, 2, { width: 844, height: 390 }, errors);
  await next(4); // a QCM open
  const pages = [...hosts, tabletLand, phoneLand];
  const names = [...Object.keys(sizes), "player-tablet-landscape", "player-phone-landscape"];
  for (const [i, pg] of pages.entries()) {
    await pg.waitForTimeout(300);
    // No horizontal scroll on any device.
    expect(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), names[i]).toBe(true);
    await pg.screenshot({ path: `screenshots/ux-${names[i]}.png` });
  }
  // The host's next-step key stays at the same place whatever the phase (fixed bottom slot).
  const host = hosts[0];
  if (host === undefined) throw new Error("host");
  const keyBox = async () => (await host.locator(".h-key-primary").boundingBox())?.y ?? -1;
  const y1 = await keyBox();
  await host.locator(".h-key-primary").click(); // lock
  await host.waitForTimeout(300);
  expect(Math.abs((await keyBox()) - y1)).toBeLessThan(2);
  const hub = await open(browser, "/", { width: 390, height: 844 }, errors);
  await hub.waitForTimeout(300);
  expect(await hub.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await hub.screenshot({ path: "screenshots/ux-hub-phone.png" });
  expect(errors).toEqual([]);
});

test("join screen on a phone", async ({ browser }) => {
  const errors: string[] = [];
  const p = await open(browser, "/play", PHONE, errors);
  await expect(p.getByRole("button", { name: "C'est parti" })).toBeVisible();
  await p.screenshot({ path: "screenshots/ux-player-phone-join.png" });
  expect(errors).toEqual([]);
});
