import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";
type Summary = { games: { id: string; title: string; questions: number }[] };

test("studio library: a new game is listed at once (empty), auto-saves, duplicates and is deleted with the app dialog", async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const studio = await ctx.newPage();
  const native: string[] = [];
  studio.on("dialog", (d) => {
    native.push(d.message());
    void d.dismiss();
  });
  const list = async (): Promise<Summary["games"]> => ((await (await request.get(`/api/games?t=${token("studio")}`)).json()) as Summary).games; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own endpoint
  await studio.goto(path("studio"));

  // Empty game: one blank question, no demo content; listed immediately, before any save.
  await studio.getByRole("button", { name: "+ Nouvelle" }).click();
  await studio.getByRole("menuitem", { name: /Partie vide/ }).click();
  await expect(studio.locator(".s-table tbody tr")).toHaveCount(1);
  await expect(studio.locator(".s-games li").filter({ hasText: "Nouvelle partie" }).first()).toBeVisible();

  // Rename → auto-saved without pressing anything.
  await studio.locator(".s-title").fill("Bibliothèque e2e");
  await expect(studio.getByRole("button", { name: "Enregistré ✓" })).toBeVisible({ timeout: 5000 });
  await expect.poll(async () => (await list()).filter((g) => g.title === "Bibliothèque e2e").length).toBe(1);

  // Duplicate from the row menu.
  const row = studio.locator(".s-games li").filter({ hasText: /^Bibliothèque e2e\d/ }).first();
  await row.getByRole("button", { name: /Actions pour/ }).click();
  await studio.getByRole("menuitem", { name: "Dupliquer" }).click();
  await expect.poll(async () => (await list()).filter((g) => g.title === "Bibliothèque e2e (copie)").length).toBe(1);

  // Delete the copy: our dialog (Échap cancels, then confirm), never the browser's confirm().
  const copy = studio.locator(".s-games li").filter({ hasText: "Bibliothèque e2e (copie)" }).first();
  await copy.getByRole("button", { name: /Actions pour/ }).click();
  await studio.getByRole("menuitem", { name: "Supprimer…" }).click();
  const dialog = studio.getByRole("dialog");
  await expect(dialog).toContainText("Supprimer « Bibliothèque e2e (copie) » ?");
  await studio.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect((await list()).some((g) => g.title === "Bibliothèque e2e (copie)")).toBe(true);
  await copy.getByRole("button", { name: /Actions pour/ }).click();
  await studio.getByRole("menuitem", { name: "Supprimer…" }).click();
  await dialog.getByRole("button", { name: "Supprimer la partie" }).click();
  await expect.poll(async () => (await list()).some((g) => g.title === "Bibliothèque e2e (copie)")).toBe(false);
  await expect(studio.locator(".s-games li").filter({ hasText: "Bibliothèque e2e (copie)" })).toHaveCount(0);

  // A template starts from its content, not from the demo.
  await studio.getByRole("button", { name: "+ Nouvelle" }).click();
  await studio.getByRole("menuitem", { name: "Plateau catégories × valeurs" }).click();
  await expect(studio.locator(".s-title")).toHaveValue("Plateau catégories × valeurs");
  expect(native).toEqual([]);
  await ctx.close();
});
