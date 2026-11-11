import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

test("studio: content, scene simulation, generated theme, save, then the output follows when launched", async ({ browser, request }) => {
  const errors: string[] = [];
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const studio = await ctx.newPage();
  studio.on("pageerror", (e) => errors.push(e.message));
  studio.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await studio.goto(path("studio"));

  await studio.getByRole("button", { name: "+ Nouvelle" }).click();
  await studio.locator(".s-title").fill("Soirée e2e");
  await studio.getByRole("button", { name: "+ QCM" }).click();
  await expect(studio.locator(".s-table tbody tr")).toHaveCount(4);

  await studio.getByRole("button", { name: "Scènes" }).click();
  await studio.getByRole("button", { name: "Personnaliser les scènes" }).click();
  await expect(studio.locator(".s-stage .q-zone-question")).toContainText("capitale de la France");
  await expect(studio.locator('.s-stage .q-answer[data-state="correct"]')).toContainText("Paris"); // simulated "revealed"
  await studio.locator(".s-zone").filter({ hasText: "question" }).first().click();
  await expect(studio.getByText("Zone « question »")).toBeVisible();
  await studio.screenshot({ path: "screenshots/studio-scenes.png" });

  await studio.getByRole("button", { name: "Thème" }).click();
  await studio.locator(".s-variant").nth(1).getByRole("button", { name: "Appliquer" }).click(); // "Clair"
  await studio.screenshot({ path: "screenshots/studio-theme.png" });
  await studio.getByRole("button", { name: /Enregistrer/ }).click();
  await expect(studio.getByText("Enregistré", { exact: true }).first()).toBeVisible();

  const games = (await (await request.get(`/api/games?t=${token("studio")}`)).json()) as { games: { id: string; title: string }[] }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own endpoint
  const g = games.games.find((x) => x.title === "Soirée e2e");
  expect(g).toBeDefined();

  const output = await ctx.newPage();
  await output.goto(path("out-program"));
  const launched = await request.post(`/api/games/${g?.id ?? ""}/launch?t=${token("control")}`);
  expect(launched.status()).toBe(200);
  // The output re-fetches the look of the new game: the "Clair" theme has a light surface colour.
  await expect.poll(async () => output.locator(".q-scene").evaluate((el) => getComputedStyle(el).getPropertyValue("--q-color-surface").trim())).toMatch(/^#e|^#f|^#d/);
  expect(errors).toEqual([]);
});
