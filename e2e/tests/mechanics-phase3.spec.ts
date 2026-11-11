import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

/** Phase 3 mechanics played end to end: tablets + control room + program output (text-answer, order, board). */

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

/** Every WebSocket frame a page received, to prove no secret reached a tablet. */
type Frames = { all: string[] };

async function open(browser: Browser, url: string, viewport: { width: number; height: number }, errors: string[], frames?: Frames): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${url.split("?")[0]} → ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${url.split("?")[0]} → ${m.text()}`); });
  if (frames !== undefined) page.on("websocket", (ws) => ws.on("framereceived", (f) => { if (typeof f.payload === "string") frames.all.push(f.payload); }));
  await page.goto(url);
  return page;
}

async function setup(browser: Browser, request: APIRequestContext, template: string, players: string, seats: number, errors: string[]) {
  expect((await request.post(`/api/games/${template}/launch?t=${token("control")}`)).status()).toBe(200);
  const control = await open(browser, path("control"), { width: 1600, height: 1000 }, errors);
  await expect(control.getByText("connecté").first()).toBeVisible();
  await control.getByText("Importer des joueurs").click();
  await control.locator(".c-csv textarea").fill(players);
  await control.getByRole("button", { name: "Importer", exact: true }).click();
  await expect(control.getByText(/joueur\(s\) importé\(s\)/)).toBeVisible();
  const output = await open(browser, path("out-program"), { width: 1920, height: 1080 }, errors);
  const tablets: { page: Page; frames: Frames }[] = [];
  for (let i = 1; i <= seats; i++) {
    const frames: Frames = { all: [] };
    const page = await open(browser, path(`seat-${i}`), { width: 600, height: 960 }, errors, frames);
    await page.getByText("Touchez l'écran pour commencer").click();
    tablets.push({ page, frames });
  }
  const next = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await control.locator("body").press("Space");
      await control.waitForTimeout(150);
    }
  };
  return { control, output, tablets, next };
}

const pair = <T,>(xs: readonly T[]): [T, T] => {
  const [a, b] = xs;
  if (a === undefined || b === undefined) throw new Error("two tablets expected");
  return [a, b];
};

test("text-answer: typed answers, fuzzy match, control overrules, answer on air at reveal only", async ({ browser, request }) => {
  const errors: string[] = [];
  const { control, output, tablets, next } = await setup(browser, request, "g_e2e_texte", "Ana;1\nBo;2", 2, errors);
  const [ana, bo] = pair(tablets);
  await next(4); // start, round, present, open
  await ana.page.locator(".p-input").fill("van gogh");
  await ana.page.getByRole("button", { name: "Envoyer" }).click();
  await expect(ana.page.getByText("Réponse enregistrée")).toBeVisible();
  await bo.page.locator(".p-input").fill("Monet");
  await bo.page.getByRole("button", { name: "Envoyer" }).click();
  await expect(bo.page.getByText("Réponse enregistrée")).toBeVisible();
  await expect(output.locator(".q-zone-answer-count")).toContainText("2");
  // Control: the review list with the automatic verdicts; overrule Bo's answer.
  const boRow = control.locator(".q-mech-review li").filter({ hasText: "Monet" });
  await expect(boRow).toHaveAttribute("data-accepted", "false");
  await expect(control.locator(".q-mech-review li").filter({ hasText: "van gogh" })).toHaveAttribute("data-accepted", "true");
  await boRow.getByTitle("Compter juste").click();
  await expect(boRow).toHaveAttribute("data-accepted", "true");
  await expect(boRow.getByText("corrigé")).toBeVisible();
  await control.screenshot({ path: "screenshots/text-control.png", fullPage: true });
  // No secret on a tablet before the reveal (screen and every frame received), nor on air.
  for (const t of tablets) {
    await expect(t.page.getByText("Vincent van Gogh")).toHaveCount(0);
    expect(t.frames.all.some((f) => f.includes("Vincent van Gogh") || f.includes("Fiche animateur"))).toBe(false);
  }
  await expect(output.locator(".q-zone-answer-list")).not.toContainText("Vincent");
  await ana.page.screenshot({ path: "screenshots/text-tablet.png" });
  await next(2); // lock, reveal
  await expect(output.locator(".q-reveal-answer")).toContainText("Vincent van Gogh");
  await expect(ana.page.getByText("Bonne réponse : Vincent van Gogh")).toBeVisible();
  await expect(ana.page.getByText("✓ Bonne réponse !")).toBeVisible();
  await expect(bo.page.getByText("✓ Bonne réponse !")).toBeVisible(); // overruled
  await output.screenshot({ path: "screenshots/text-output.png" });
  expect(errors).toEqual([]);
});

const ORDER = ["Invention de l'imprimerie", "Découverte de l'Amérique", "Révolution française", "Premier pas sur la Lune"];

test("order: up / down buttons build the ordering, the right order goes on air at reveal", async ({ browser, request }) => {
  const errors: string[] = [];
  const { output, tablets, next } = await setup(browser, request, "g_e2e_ordre", "Ana;1\nBo;2", 2, errors);
  const [ana, bo] = pair(tablets);
  await next(4);
  await expect(output.locator(".q-order")).toHaveAttribute("data-revealed", "false");
  await expect(output.locator(".q-order-item")).toHaveCount(4);
  // Ana sorts the list into the right order with ▲ only.
  const items = ana.page.locator(".p-order-item .p-label");
  for (let target = 0; target < ORDER.length; target++) {
    const labels = await items.allInnerTexts();
    const at = labels.indexOf(ORDER[target] ?? "");
    for (let j = at; j > target; j--) await ana.page.locator(".p-order-item").nth(j).getByRole("button", { name: "Monter" }).click();
  }
  await expect(items).toHaveText(ORDER);
  await ana.page.getByRole("button", { name: "Valider cet ordre" }).click();
  await expect(ana.page.getByText("Réponse enregistrée")).toBeVisible();
  await bo.page.getByRole("button", { name: "Valider cet ordre" }).click(); // shown order: never the right one
  await expect(bo.page.getByText("Réponse enregistrée")).toBeVisible();
  for (const t of tablets) expect(t.frames.all.some((f) => /"correct":\["/.test(f) || f.includes("Fiche animateur"))).toBe(false);
  await ana.page.screenshot({ path: "screenshots/order-tablet.png" });
  await next(2); // lock, reveal
  await expect(output.locator(".q-order")).toHaveAttribute("data-revealed", "true");
  await expect(output.locator(".q-order-item")).toHaveText(ORDER.map((l, i) => new RegExp(`${i + 1}\\s*${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)));
  await expect(ana.page.getByText("✓ Bonne réponse !")).toBeVisible();
  await expect(bo.page.getByText("✗ Raté")).toBeVisible();
  await expect(ana.page.getByText(`Bonne réponse : ${ORDER.join(" → ")}`)).toBeVisible();
  await output.screenshot({ path: "screenshots/order-output.png" });
  expect(errors).toEqual([]);
});

test("board: control picks a cell on the grid, first buzz judged, played cell dimmed", async ({ browser, request }) => {
  const errors: string[] = [];
  const { control, output, tablets, next } = await setup(browser, request, "g_modele_plateau", "Ana;1\nBo;2", 2, errors);
  const [ana, bo] = pair(tablets);
  await next(2); // start, round → the grid, nothing in play
  const cells = control.locator(".q-board-pick-cell");
  await expect(cells).toHaveCount(6);
  await expect(ana.page.getByText("La régie choisit une case")).toBeVisible();
  // Grid order: row 200 (Sciences, Géographie, Lettres), row 400 (…): nth(4) = Géographie 400.
  await cells.nth(4).click();
  await expect(control.getByText("Case : Géographie pour 400")).toBeVisible();
  await expect(output.locator(".q-zone-question")).toContainText("Plus haut sommet d'Afrique");
  await expect(output.locator('.q-board-cell[data-state="selected"]')).toHaveText("400");
  await expect(output.locator(".q-board-current")).toContainText("Géographie");
  await next(1); // open
  await ana.page.getByRole("button", { name: "BUZZ" }).click();
  await expect(ana.page.getByText("Vous avez la main")).toBeVisible();
  await bo.page.getByRole("button", { name: "BUZZ" }).click();
  await expect(bo.page.getByText("En file")).toBeVisible();
  await expect(output.locator(".q-zone-buzzer")).toContainText("Ana");
  for (const t of tablets) expect(t.frames.all.some((f) => f.includes("Kilimandjaro") || f.includes("Fiche animateur"))).toBe(false);
  await expect(control.getByText("Réponse attendue : Le Kilimandjaro")).toBeVisible();
  await control.getByRole("button", { name: "✓ Bonne réponse" }).click();
  await expect(control.getByText("Ana a trouvé")).toBeVisible();
  await expect(ana.page.getByText("Bravo")).toBeVisible();
  await output.screenshot({ path: "screenshots/board-output-cell.png" });
  await next(2); // lock, reveal
  await expect(output.locator(".q-reveal-answer")).toContainText("Le Kilimandjaro");
  await expect(ana.page.getByText("400 pts")).toBeVisible();
  await next(1); // next → back to the grid
  await expect(cells.nth(4)).toHaveAttribute("data-played", "true");
  await expect(cells.nth(4)).toBeDisabled();
  await expect(cells.nth(0)).toBeEnabled();
  await ana.page.screenshot({ path: "screenshots/board-tablet.png" });
  expect(errors).toEqual([]);
});
