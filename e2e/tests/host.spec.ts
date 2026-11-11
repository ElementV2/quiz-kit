import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.beforeEach(async ({ request }) => {
  expect((await request.post(`/api/games/g_modele_qcm/launch?t=${token("control")}`)).status()).toBe(200);
});

async function open(browser: Browser, url: string, viewport: { width: number; height: number }, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 1300 });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${url.split("?")[0]} → ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${url.split("?")[0]} → ${m.text()}`); });
  await page.goto(url);
  return page;
}

const LANDSCAPE = { width: 1280, height: 800 };
const PORTRAIT = { width: 800, height: 1280 };

test("host reads the next question before anything is on air, then follows the control room", async ({ browser }) => {
  const errors: string[] = [];
  const control = await open(browser, path("control"), { width: 1366, height: 768 }, errors);
  const host = await open(browser, path("host"), LANDSCAPE, errors);
  await expect(host.getByText("Pas encore à l'antenne — à lire")).toBeVisible();
  await expect(host.locator(".h-question")).toContainText("capitale de la France");
  await expect(host.locator(".h-answer-main")).toHaveText("Paris");
  await expect(host.locator(".h-notes")).toContainText("Hugues Capet");
  await expect(host.getByText("Pilotage : régie")).toBeVisible();
  await expect(host.locator(".h-keys")).toHaveCount(0);
  await host.screenshot({ path: "screenshots/ux-host-landscape-next.png" });

  for (let i = 0; i < 3; i++) {
    await control.locator("body").press("Space"); // start, round, present
    await control.waitForTimeout(150);
  }
  await expect(host.getByText("À l'antenne", { exact: true })).toBeVisible();
  await control.locator("body").press("Space"); // open
  await expect(host.locator(".h-clock-time")).not.toHaveText("–:––");

  // Run-down: preview another question (read only), then back to what is on air.
  await host.getByRole("button", { name: "Déroulé" }).click();
  await host.locator(".h-rq").filter({ hasText: "nombres premiers" }).click();
  await expect(host.getByText("Aperçu — pas à l'antenne")).toBeVisible();
  await expect(host.locator(".h-answer-main")).toHaveText("2 + 13");
  await host.getByRole("button", { name: "Revenir au direct" }).click();
  await expect(host.locator(".h-question")).toContainText("capitale de la France");
  expect(errors).toEqual([]);
});

test("with drive on, the host presents, opens, reveals and skips from the tablet; the output follows", async ({ browser }) => {
  const errors: string[] = [];
  const control = await open(browser, path("control"), { width: 1366, height: 768 }, errors);
  const output = await open(browser, path("out-program"), { width: 1920, height: 1080 }, errors);
  const host = await open(browser, path("host"), LANDSCAPE, errors);
  await control.getByRole("switch", { name: "L'animateur pilote" }).click();
  await expect(host.getByText("Vous pilotez")).toBeVisible();

  const key = host.locator(".h-key-primary");
  await expect(key).toHaveText("Démarrer la partie");
  await key.click();
  await expect(key).toHaveText("Démarrer la manche");
  await key.click();
  await expect(key).toHaveText("Présenter la question");
  await key.click();
  await expect(output.locator(".q-zone-question")).toContainText("capitale de la France");
  await expect(key).toHaveText("Ouvrir les réponses");
  await key.click();
  await expect(key).toHaveText("Fermer les réponses");
  await host.screenshot({ path: "screenshots/ux-host-landscape-onair.png" });
  await host.getByRole("button", { name: "Révéler", exact: true }).click();
  await expect(output.locator('.q-answer[data-state="correct"]').first()).toContainText("Paris");
  await key.click(); // Question suivante
  await expect(host.getByText("Pas encore à l'antenne — à lire")).toBeVisible();
  await expect(host.locator(".h-question")).toContainText("La Terre est plate");

  // Pick question 3 in the run-down and present it directly (skipping question 2).
  await host.getByRole("button", { name: "Déroulé" }).click();
  await host.locator(".h-rq").filter({ hasText: "nombres premiers" }).click();
  await host.getByRole("button", { name: "Présenter celle-ci" }).click();
  await expect(output.locator(".q-zone-question")).toContainText("nombres premiers");
  await expect(host.getByText("À l'antenne", { exact: true })).toBeVisible();

  // Skip needs a second tap (no modal on a tablet).
  const skip = host.getByRole("button", { name: "Passer la question" });
  await skip.click();
  await expect(host.getByRole("button", { name: /Confirmer : passer/ })).toBeVisible();
  await host.getByRole("button", { name: /Confirmer : passer/ }).click();
  await expect(host.locator(".h-top")).toContainText("Fin de partie");
  expect(errors).toEqual([]);
});

test("portrait tablet layout", async ({ browser }) => {
  const errors: string[] = [];
  const control = await open(browser, path("control"), { width: 1366, height: 768 }, errors);
  const host = await open(browser, path("host"), PORTRAIT, errors);
  await control.getByRole("switch", { name: "L'animateur pilote" }).click();
  for (let i = 0; i < 4; i++) {
    await control.locator("body").press("Space");
    await control.waitForTimeout(150);
  }
  await expect(host.locator(".h-key-primary")).toHaveText("Fermer les réponses");
  await host.screenshot({ path: "screenshots/ux-host-portrait-onair.png" });
  await control.getByRole("switch", { name: "L'animateur pilote" }).click();
  await expect(host.getByText("Pilotage : régie")).toBeVisible();
  await host.screenshot({ path: "screenshots/ux-host-portrait-control-drives.png" });
  expect(errors).toEqual([]);
});

test("with drive off the keys are absent and a flow intent from the host is refused", async ({ browser }) => {
  const errors: string[] = [];
  const host = await open(browser, path("host"), LANDSCAPE, errors);
  await expect(host.getByText("Pilotage : régie")).toBeVisible();
  await expect(host.locator(".h-key-primary")).toHaveCount(0);
  await expect(host.getByRole("button", { name: "Passer la question" })).toHaveCount(0);
  // A forged intent on a raw socket with the host token: the server refuses it (the UI only hides the key).
  const ack = await host.evaluate(async (t) => {
    return await new Promise<{ ok: boolean; code?: string }>((resolve) => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hello", v: 1, token: t, clientId: "e2e_forged_host" })));
      ws.addEventListener("message", (m) => {
        const msg = JSON.parse(String(m.data)) as { t: string; ok?: boolean; code?: string }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- server message, test only
        if (msg.t === "welcome") ws.send(JSON.stringify({ t: "intent", key: "e2e_forged_0001", action: { type: "game.start" } }));
        if (msg.t === "ack") {
          resolve({ ok: msg.ok === true, ...(msg.code === undefined ? {} : { code: msg.code }) });
          ws.close();
        }
      });
    });
  }, token("host"));
  expect(ack.ok).toBe(false);
  await expect(host.locator(".h-top")).toContainText("Avant la partie");
  expect(errors).toEqual([]);
});
