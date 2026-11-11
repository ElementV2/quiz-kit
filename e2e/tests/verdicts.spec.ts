import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

/**
 * Correcting a player's verdict: the keys (✓ / ✗ lit), the « corrigé » tag and the scores always agree — on the
 * question on air (before and after the reveal) and on a question already played (« Corriger » in the run-down).
 */
test("verdict corrections: what is lit always matches the points, live and on a past question", async ({ browser, request }) => {
  expect((await request.post(`/api/games/g_e2e_qcm/launch?t=${token("control")}&players=new`)).status()).toBe(200);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const control = await ctx.newPage();
  await control.goto(path("control"));
  await expect(control.getByText("connecté").first()).toBeVisible();
  await control.getByText("Importer des joueurs").click();
  await control.locator(".c-csv textarea").fill("Ana;1\nBo;2");
  await control.getByRole("button", { name: "Importer", exact: true }).click();
  const tabCtx = await browser.newContext({ viewport: { width: 800, height: 1000 }, hasTouch: true });
  const ana = await tabCtx.newPage();
  await ana.goto(path("seat-1"));
  await ana.getByText("Touchez l'écran pour commencer").click();
  const space = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await control.locator("body").press("Space");
      await control.waitForTimeout(200);
    }
  };
  await space(4); // start, round, present, open: « Quelle est la capitale de la France ? »
  await ana.locator(".p-option").filter({ hasText: "Paris" }).click();
  const row = control.locator(".q-mech-review li").filter({ hasText: "Ana" });
  await expect(row).toHaveAttribute("data-accepted", "true");

  // Before the reveal: counted wrong by hand → ✗ lit, « corrigé ».
  await row.getByTitle("Compter faux").click();
  await expect(row).toHaveAttribute("data-accepted", "false");
  await expect(row.locator(".q-toggle-no")).toHaveAttribute("data-on", "true");
  await expect(row.getByText("corrigé")).toBeVisible();
  await space(2); // lock, reveal
  await expect(ana.locator(".p-score")).toContainText("0 pts");
  await expect(ana.getByText("✗ Raté…")).toBeVisible();

  // After the reveal: back to automatic (the same key again) → right again, points back.
  await row.getByTitle("Revenir au verdict automatique").click();
  await expect(row).toHaveAttribute("data-accepted", "true");
  await expect(row.getByText("corrigé")).toBeHidden();
  await expect(ana.locator(".p-score")).not.toContainText(" 0 pts");
  const scored = (await ana.locator(".p-score").textContent()) ?? "";

  // On the question already played: « Corriger » lists the answers; ✗ there takes the points away — and stays lit.
  await space(1); // next
  await control.locator(".c-q-row").first().getByRole("button", { name: "Corriger" }).click();
  const past = control.locator(".c-past li").filter({ hasText: "Ana" });
  await expect(past).toHaveAttribute("data-accepted", "true");
  await past.getByTitle("Compter faux").click();
  await expect(past).toHaveAttribute("data-accepted", "false");
  await expect(past.locator(".q-toggle-no")).toHaveAttribute("data-on", "true");
  await expect(ana.locator(".p-score")).toContainText("0 pts");
  await past.getByTitle("Revenir au verdict automatique").click();
  await expect(past).toHaveAttribute("data-accepted", "true");
  await expect(ana.locator(".p-score")).toHaveText(scored);
  await ctx.close();
  await tabCtx.close();
});
