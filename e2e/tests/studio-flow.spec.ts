import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
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
  page.on("dialog", (d) => void d.accept());
  return errors;
};

const center = async (l: Locator): Promise<{ x: number; y: number }> => {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not visible");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** Mouse drag between two points, in small steps (pointer events, like a user). */
const dragBetween = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
};

test("studio Format « Enchaînement »: main → (tie) barrage loop → final → Fin, built on the graph, simulated and saved", async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const studio = await ctx.newPage();
  const errors = watch(studio);
  await studio.goto(path("studio"));
  await studio.getByRole("button", { name: "+ Nouvelle" }).click();
  await studio.locator(".s-title").fill("Enchaînement e2e");

  // Three rounds in the list: main (the template's), final, barrage — each with a question of the bank.
  await studio.getByRole("button", { name: "Format", exact: true }).click();
  await studio.locator(".s-round").nth(0).getByLabel("Titre de la manche").fill("Manche principale");
  for (const [i, title] of [[1, "Finale"], [2, "Barrage"]] as const) {
    await studio.getByRole("button", { name: "+ Ajouter une manche" }).click();
    const r = studio.locator(".s-round").nth(i);
    await r.getByLabel("Titre de la manche").fill(title);
    await r.getByLabel("Ajouter à : Questions jouées (dans l'ordre)").selectOption({ index: 1 });
  }

  // Graph view: list order drawn dashed (main → final → barrage → Fin), no transition yet.
  await studio.getByRole("button", { name: "Enchaînement" }).click();
  const node = (title: string) => studio.locator(`.s-flow-node[data-title="${title}"]`);
  const port = (title: string) => node(title).locator(".s-flow-out");
  await expect(node("Manche principale")).toBeVisible();
  await expect(node("Fin")).toBeVisible();
  await expect(studio.locator('.s-flow-edge[data-kind="list"]')).toHaveCount(3);
  await expect(studio.locator('.s-flow-edge[data-kind="flow"]')).toHaveCount(0);
  await expect(studio.getByText("Enchaînement valide")).toBeVisible();

  // main → barrage: the first exit defaults to « toujours », switched to « si égalité ».
  await dragBetween(studio, await center(port("Manche principale")), await center(node("Barrage")));
  const inspector = studio.getByTestId("flow-edge");
  const cond = inspector.getByRole("group", { name: "Condition" });
  await expect(inspector).toContainText("« Manche principale » → « Barrage »");
  await expect(cond.getByRole("button", { name: "toujours" })).toHaveAttribute("data-on", "true");
  await cond.getByRole("button", { name: "si égalité" }).click();
  // Only a tie exit: the fall-through to the list order is drawn and explained.
  await expect(studio.locator(".s-flow-issues")).toContainText("« Manche principale » : sans égalité, aucune transition ne s'applique ; la partie passe à la manche suivante de la liste, « Finale »");
  await expect(studio.locator('.s-flow-label[data-kind="list"][data-from="Manche principale"] .s-flow-chip')).toContainText("sinon : ordre de la liste");

  // main → final from the « + suite » menu: completes the tie with « sinon (pas d'égalité) », priority 2.
  await node("Manche principale").getByRole("button", { name: "Ajouter une suite à « Manche principale »" }).click();
  await studio.getByRole("menu").getByRole("menuitem", { name: /Finale/ }).click();
  await expect(inspector).toContainText("« Manche principale » → « Finale »");
  await expect(cond.getByRole("button", { name: "sinon (pas d'égalité)" })).toHaveAttribute("data-on", "true");
  await expect(inspector.locator(".s-flow-prio li")).toHaveCount(2);
  await expect(inspector.locator('.s-flow-prio li[data-on="true"]')).toContainText("2");
  // Reorder: up then down again.
  await inspector.locator('.s-flow-prio li[data-on="true"]').getByTitle("Plus prioritaire").click();
  await expect(inspector.locator(".s-flow-prio li").first()).toContainText("Finale");
  await inspector.locator('.s-flow-prio li[data-on="true"]').getByTitle("Moins prioritaire").click();
  await expect(inspector.locator(".s-flow-prio li").first()).toContainText("Barrage");

  // Barrage loops on itself while tied (drop on its own node), and goes to the final otherwise.
  await dragBetween(studio, await center(port("Barrage")), await center(node("Barrage")));
  await expect(inspector).toContainText("« Barrage » → « Barrage »");
  await expect(cond.getByRole("button", { name: "si égalité" })).toHaveAttribute("data-on", "true");
  await dragBetween(studio, await center(port("Barrage")), await center(node("Finale")));
  await expect(cond.getByRole("button", { name: "sinon (pas d'égalité)" })).toHaveAttribute("data-on", "true");
  await dragBetween(studio, await center(port("Finale")), await center(node("Fin")));
  await expect(inspector).toContainText("« Finale » → « Fin »");
  await expect(studio.locator('.s-flow-edge[data-kind="flow"]')).toHaveCount(5);
  await expect(studio.locator('.s-flow-edge[data-kind="list"]')).toHaveCount(0);
  await expect(studio.getByText("Enchaînement valide")).toBeVisible();

  // Suppr deletes the selected transition, Ctrl+Z brings it back, Échap deselects.
  await studio.keyboard.press("Delete");
  await expect(studio.locator('.s-flow-edge[data-kind="flow"]')).toHaveCount(4);
  await expect(studio.locator('.s-flow-edge[data-kind="list"][data-from="Finale"]')).toHaveCount(1);
  await studio.keyboard.press("Control+z");
  await expect(studio.locator('.s-flow-edge[data-kind="flow"]')).toHaveCount(5);
  await studio.locator('.s-flow-label[data-from="Barrage"][data-to="Barrage"] .s-flow-chip').click();
  await expect(inspector).toContainText("« Barrage » → « Barrage »");
  await studio.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);

  // Move the final node right of the barrage, a bit lower (two columns right): its position is kept, « Fin » follows.
  const column = ((await center(node("Barrage"))).x - (await center(node("Manche principale"))).x) / 2;
  const fin = await center(node("Finale").locator(".s-flow-mech"));
  await dragBetween(studio, fin, { x: fin.x + 2 * column, y: fin.y + column * 0.5 });
  await expect(studio.getByTestId("flow-node")).toContainText("Finale");
  await studio.locator(".s-flow-toolbar").getByRole("button", { name: "Ajuster" }).click();

  // Simulation: main tied, barrage broken → main → barrage → final → Fin, path highlighted.
  await studio.locator(".s-flow-side").getByRole("switch").click();
  await studio.getByRole("group", { name: "Fin de « Manche principale »" }).getByRole("button", { name: "égalité", exact: true }).click();
  await expect(studio.locator(".s-flow-path li")).toHaveText(["Manche principale (égalité)", "Barrage (pas d'égalité)", "Finale (pas d'égalité)", "Fin"]);
  await expect(studio.locator('.s-flow-edge[data-state="path"]')).toHaveCount(3);
  await expect(node("Barrage")).toHaveAttribute("data-path", "true");
  await studio.getByRole("group", { name: "Fin de « Barrage »" }).getByRole("button", { name: "égalité", exact: true }).click();
  await expect(studio.locator(".s-flow-path")).toContainText("« Barrage » se rejoue sans fin");
  await studio.getByRole("group", { name: "Fin de « Barrage »" }).getByRole("button", { name: "pas d'égalité" }).click();
  await studio.locator('.s-flow-label[data-from="Manche principale"][data-to="Barrage"] .s-flow-chip').click();
  await studio.screenshot({ path: "screenshots/studio-flow.png" });

  // Saved document: the flow in priority order, the moved node's position.
  await studio.getByRole("button", { name: /Enregistrer/ }).click();
  await expect(studio.getByText("Enregistré", { exact: true }).first()).toBeVisible();
  const games = (await (await request.get(`/api/games?t=${token("studio")}`)).json()) as { games: { id: string; title: string }[] }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own endpoint
  const id = games.games.find((g) => g.title === "Enchaînement e2e")?.id ?? "";
  const body = (await (await request.get(`/api/games/${id}?t=${token("studio")}`)).json()) as { game: unknown }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own endpoint
  const saved = GameDocument.safeParse(body.game);
  expect(saved.success).toBe(true);
  const format = saved.data?.format;
  const title = (rid: string) => (rid === "end" ? "Fin" : (format?.rounds.find((r) => r.id === rid)?.title ?? rid));
  expect(format?.rounds.map((r) => r.title)).toEqual(["Manche principale", "Finale", "Barrage"]);
  expect(format?.flow?.map((t) => [title(t.from), title(t.to), t.when])).toEqual([
    ["Manche principale", "Barrage", "tie"],
    ["Manche principale", "Finale", "no-tie"],
    ["Barrage", "Barrage", "tie"],
    ["Barrage", "Finale", "no-tie"],
    ["Finale", "Fin", "always"],
  ]);
  const finalId = format?.rounds[1]?.id ?? "";
  expect(Object.keys(format?.flowLayout ?? {})).toEqual([finalId]);
  expect(errors).toEqual([]);
  await ctx.close();
});
