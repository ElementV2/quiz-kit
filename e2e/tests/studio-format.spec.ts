import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { GameDocument } from "@quiz/schema";

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

const watch = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("dialog", () => { throw new Error("native browser dialog: use the app dialog"); });
  return errors;
};

test("studio Format: a ladder round + a mixed round (free text + order) built from the bank, saved and valid", async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const studio = await ctx.newPage();
  const errors = watch(studio);
  await studio.goto(path("studio"));
  await studio.getByRole("button", { name: "+ Nouvelle" }).click();
  await studio.getByRole("menuitem", { name: "QCM rapide (Kahoot-like)" }).click(); // the demo questions
  await studio.locator(".s-title").fill("Format e2e");

  // Round 1 becomes "Paliers" (single-answer QCM only): the boolean and multi questions are flagged by the engine's own init.
  await studio.getByRole("button", { name: "Format", exact: true }).click();
  const round1 = studio.locator(".s-round").nth(0);
  await round1.getByLabel("Type de manche").selectOption("ladder");
  await expect(round1.getByText("⚠ question incompatible").first()).toBeVisible();
  await expect(round1.getByText("⚠ question incompatible")).toHaveCount(2);

  // Round 2: a new round is « Mixte » (every question kind), empty for now (warned).
  await studio.getByRole("button", { name: "+ Ajouter une manche" }).click();
  const round2 = studio.locator(".s-round").nth(1);
  await expect(round2.getByText(/aucune question/).first()).toBeVisible();
  await expect(round2.getByLabel("Type de manche")).toHaveValue("mixed");
  await round2.getByLabel("Titre de la manche").fill("Chronologie");
  await expect(round2.getByText(/Toutes les questions dans la même manche/)).toBeVisible();
  // Config form of a special format (board values), then back to mixed.
  await round2.getByLabel("Type de manche").selectOption("board");
  await expect(round2.getByText("Valeurs des cases, de haut en bas")).toBeVisible();
  await round2.getByLabel("Type de manche").selectOption("mixed");
  await studio.screenshot({ path: "screenshots/studio-format.png" });

  // Bank: a new order question goes to the last round by default, a free-text one to round 1.
  await studio.getByRole("button", { name: "Contenu" }).click();
  await studio.getByRole("button", { name: "+ Remettre dans l'ordre" }).click();
  await expect(studio.getByText("Question ajoutée à « Chronologie »")).toBeVisible();
  await studio.getByRole("button", { name: "+ Réponse libre" }).click(); // same mixed round: any kind fits
  const textRow = studio.locator(".s-table tbody tr").filter({ hasText: "Réponses acceptées" });
  await textRow.locator(".s-opt input").first().fill("Victor Hugo");
  await textRow.getByRole("button", { name: "+ variante acceptée" }).click();
  // Incompatible questions of round 1 are deleted from the bank (and so from the round).
  for (const kind of [/^Vrai \/ faux$/, /^Plusieurs réponses$/]) {
    await studio.locator(".s-table tbody tr").filter({ has: studio.locator(".s-col-q > .s-kind", { hasText: kind }) }).getByTitle("Supprimer la question").click();
    await studio.getByRole("dialog").getByRole("button", { name: "Supprimer" }).click();
  }
  await expect(studio.locator(".s-table tbody tr")).toHaveCount(3);
  await studio.screenshot({ path: "screenshots/studio-content-bank.png" });

  await studio.getByRole("button", { name: "Format", exact: true }).click();
  await expect(studio.getByText("⚠ question incompatible")).toHaveCount(0);
  await expect(studio.getByText(/aucune question \(/)).toHaveCount(0);
  await expect(studio.locator(".s-round").nth(0).locator(".s-qlist").first().locator("li")).toHaveCount(1);
  await expect(studio.locator(".s-round").nth(1).locator(".s-qlist").first().locator("li")).toHaveCount(2);

  await studio.getByRole("button", { name: /^(Enregistr|Modifications|Non enregistré)/ }).click();
  await expect(studio.getByText("Enregistré", { exact: true }).first()).toBeVisible();
  const games = (await (await request.get(`/api/games?t=${token("studio")}`)).json()) as { games: { id: string; title: string }[] }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own endpoint
  const id = games.games.find((g) => g.title === "Format e2e")?.id ?? "";
  const body = (await (await request.get(`/api/games/${id}?t=${token("studio")}`)).json()) as { game: unknown }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own endpoint
  const saved = GameDocument.safeParse(body.game);
  expect(saved.success).toBe(true);
  const rounds = saved.data?.format.rounds ?? [];
  expect(rounds.map((r) => [r.mechanic, r.questions.length])).toEqual([["ladder", 1], ["mixed", 2]]);
  const free = saved.data?.questions.find((q) => q.answerSpec.kind === "text");
  expect(free?.answerSpec).toMatchObject({ kind: "text", accepted: ["Victor Hugo", "Variante"] });
  expect(errors).toEqual([]);
  await ctx.close();
});

for (const vp of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  test(`studio Scenes ${vp.width}×${vp.height}: select, delete, undo, nudge with the keyboard; inspector always on screen`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: vp });
    const studio = await ctx.newPage();
    const errors = watch(studio);
    await studio.goto(path("studio"));
    await studio.getByRole("button", { name: "+ Nouvelle" }).click();
    await studio.getByRole("menuitem", { name: /Partie vide/ }).click();
    await studio.getByRole("button", { name: "Scènes" }).click();
    await studio.getByRole("button", { name: "Personnaliser les scènes" }).click();
    await expect(studio.getByText("Cliquez une zone pour la modifier.")).toBeVisible();

    // The whole stage is visible (fits width AND height), without page scroll.
    const stage = await studio.locator(".s-stage").boundingBox();
    expect(stage).not.toBeNull();
    expect((stage?.y ?? 0) + (stage?.height ?? 0)).toBeLessThanOrEqual(vp.height);
    expect(await studio.evaluate(() => document.scrollingElement?.scrollHeight ?? 0)).toBeLessThanOrEqual(vp.height);

    const zones = studio.locator(".s-stage .s-zone");
    const count = await zones.count();
    await studio.locator(".s-ol-zone", { hasText: "question" }).first().click();
    await expect(studio.locator(".s-inspector-head")).toContainText("Zone « question »");
    const del = studio.locator(".s-inspector-head").getByRole("button", { name: "Supprimer" });
    await expect(del).toBeInViewport();
    await expect(studio.locator(".s-inspector-head").getByRole("button", { name: "Dupliquer" })).toBeInViewport();

    await studio.keyboard.press("Delete");
    await expect(zones).toHaveCount(count - 1);
    await expect(studio.locator('.s-stage .s-zone[data-key]').filter({ hasText: /^question$/ })).toHaveCount(0);
    await studio.keyboard.press("Control+z");
    await expect(zones).toHaveCount(count);

    // Select on the canvas, then nudge: 1 px, Shift = 10 px.
    await studio.locator(".s-stage .s-zone").filter({ hasText: /^question$/ }).click({ position: { x: 40, y: 20 } });
    const x = studio.locator(".s-inspector").getByLabel("X", { exact: true });
    const y = studio.locator(".s-inspector").getByLabel("Y", { exact: true });
    const x0 = Number(await x.inputValue());
    const y0 = Number(await y.inputValue());
    await studio.keyboard.press("ArrowLeft");
    await expect(x).toHaveValue(String(x0 - 1));
    await studio.keyboard.press("Shift+ArrowUp");
    await expect(y).toHaveValue(String(y0 - 10));
    await studio.keyboard.press("Control+z"); // the nudges are one step
    await expect(x).toHaveValue(String(x0));
    await expect(y).toHaveValue(String(y0));

    // Duplicate, Escape deselects, help lists the shortcuts.
    await studio.keyboard.press("Control+d");
    await expect(zones).toHaveCount(count + 1);
    await studio.keyboard.press("Escape");
    await expect(studio.getByText("Cliquez une zone pour la modifier.")).toBeVisible();
    await studio.keyboard.press("?");
    await expect(studio.getByRole("dialog", { name: "Raccourcis clavier" })).toBeVisible();
    await studio.keyboard.press("Escape");

    // Rubber band over the bottom half selects several zones.
    const box = await studio.locator(".s-canvas").boundingBox();
    if (box === null) throw new Error("canvas");
    await studio.mouse.move(box.x + 4, box.y + box.height * 0.5);
    await studio.mouse.down();
    await studio.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 6 });
    await studio.mouse.up();
    await expect(studio.locator(".s-inspector-head")).toContainText("zones sélectionnées");
    await expect(del).toBeInViewport();
    await studio.screenshot({ path: `screenshots/studio-scenes-${vp.width}.png` });
    expect(errors).toEqual([]);
    await ctx.close();
  });
}

test("studio Replay: the journal of the current session replays step by step without error", async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  // A fresh session with a few journaled events: launch a template, then drive it from the control room.
  expect((await request.post(`/api/games/g_modele_qcm/launch?t=${token("control")}`)).status()).toBe(200);
  const control = await ctx.newPage();
  await control.goto(path("control"));
  await expect(control.getByText("connecté").first()).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await control.locator("body").press("Space"); // start, round, present, open
    await control.waitForTimeout(150);
  }
  const studio = await ctx.newPage();
  const errors = watch(studio);
  await studio.goto(path("studio"));
  await studio.getByRole("button", { name: "Replay" }).click();
  await expect(studio.locator(".s-transport")).toBeVisible();
  await expect.poll(async () => Number((await studio.locator(".s-step").innerText()).split("/")[1]?.trim() ?? "0")).toBeGreaterThanOrEqual(3);
  const total = Number((await studio.locator(".s-step").innerText()).split("/")[1]?.trim() ?? "0");
  await expect(studio.locator(".s-step")).toHaveText(`${total} / ${total}`); // opens on the latest state
  await studio.getByTitle("Début").click();
  await expect(studio.locator(".s-step")).toHaveText(`0 / ${total}`);
  await studio.getByTitle("Événement suivant").click();
  await expect(studio.locator(".s-step")).toHaveText(`1 / ${total}`);
  await expect(studio.locator(".s-current")).toContainText("#1");
  await studio.locator(".s-scrub").fill(String(total - 1));
  await expect(studio.locator(".s-step")).toHaveText(`${total - 1} / ${total}`);
  await studio.getByTitle("Fin").click();
  await expect(studio.locator(".s-replay-stage .q-scene")).toBeVisible();
  await studio.screenshot({ path: "screenshots/studio-replay.png" });
  expect(errors).toEqual([]);
  await ctx.close();
});
