import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const controlToken = (): string => path("control").split("t=")[1] ?? "";

test("studio « Envoyer au direct »: a question added to the live game reaches the control room without relaunching", async ({ browser, request }) => {
  expect((await request.post(`/api/games/g_modele_qcm/launch?t=${controlToken()}`)).status()).toBe(200);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const control = await ctx.newPage();
  await control.goto(path("control"));
  for (let i = 0; i < 2; i++) {
    await control.locator("body").press("Space"); // start, round: the show is running
    await control.waitForTimeout(150);
  }
  const studio = await ctx.newPage();
  const native: string[] = [];
  studio.on("dialog", (d) => {
    native.push(d.message());
    void d.dismiss();
  });
  await studio.goto(path("studio"));
  await studio.locator(".s-games li").filter({ hasText: "Modèle — QCM rapide (Kahoot-like)" }).locator(".s-game-open").click();
  await expect(studio.locator(".s-live-tag")).toHaveText("En direct", { timeout: 8000 });
  await expect(studio.getByRole("button", { name: "Direct à jour ✓" })).toBeDisabled();

  await studio.getByRole("button", { name: "+ QCM" }).first().click();
  await studio.locator(".s-table tbody tr").last().locator("textarea").first().fill("Question ajoutée pendant le show ?");
  await studio.getByRole("button", { name: "Envoyer au direct" }).click();
  await expect(studio.getByText("Envoyé au direct")).toBeVisible();
  await expect(control.getByText("Question ajoutée pendant le show ?")).toBeVisible();
  await expect(control.locator(".c-game-edited")).toBeVisible(); // the control room sees the studio edited the game
  await expect(studio.getByRole("button", { name: "Direct à jour ✓" })).toBeDisabled();
  // Between two questions, « Passer la question » passes the upcoming one (a question the round cannot play never blocks).
  await control.getByRole("button", { name: "Passer la question" }).click();
  await control.getByRole("dialog").getByRole("button", { name: "Passer la question" }).click();
  await expect(control.getByText("Question passée : la suivante est prête")).toBeVisible();
  expect(native).toEqual([]);
  await ctx.close();
});
