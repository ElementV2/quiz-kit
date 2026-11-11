import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const controlToken = (): string => path("control").split("t=")[1] ?? "";

test.beforeEach(async ({ request }) => {
  expect((await request.post(`/api/games/g_e2e_qcm/launch?t=${controlToken()}&players=new`)).status()).toBe(200);
});

const guard = (page: Page, errors: string[]): void => {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => {
    errors.push(`native dialog: ${d.message()}`);
    void d.dismiss();
  });
};

test("a free seat tablet seats its player by name; the control room raises the stakes (×3) live, shown everywhere and scored", async ({ browser, request }) => {
  const errors: string[] = [];
  const open = async (url: string, viewport: { width: number; height: number }) => {
    const page = await (await browser.newContext({ viewport })).newPage();
    guard(page, errors);
    await page.goto(url);
    return page;
  };
  const control = await open(path("control"), { width: 1600, height: 1000 });
  const output = await open(path("out-program"), { width: 1920, height: 1080 });
  const seat = await open(path("seat-1"), { width: 820, height: 1180 });
  await seat.getByText("Touchez l'écran pour commencer").click();

  // Nobody on seat 1: the tablet says so and seats its player itself.
  await expect(seat.getByText("Siège libre")).toBeVisible();
  await expect(seat.locator(".p-claim-seat")).toHaveText("SIÈGE 1");
  await seat.getByLabel("Votre prénom ou pseudo").fill("Zoé");
  await seat.getByRole("button", { name: "Je m'installe" }).click();
  await expect(seat.getByText("Siège libre")).toBeHidden();
  await expect(control.getByText("Zoé").first()).toBeVisible();

  // Start, round, present (answers open) → stakes ×3 from the control room.
  for (let i = 0; i < 3; i++) {
    await control.locator("body").press("Space");
    await control.waitForTimeout(150);
  }
  await control.getByRole("group", { name: /Mise de cette question/ }).getByRole("button", { name: "×3" }).click();
  await expect(output.locator(".q-stakes-onair")).toHaveText("×3");
  await expect(seat.locator(".q-stakes-badge")).toHaveText("×3");
  // The answers opened with the presentation (round default).
  await seat.getByRole("button", { name: /Paris/ }).click();
  await expect(seat.getByText("Réponse enregistrée")).toBeVisible();
  await control.locator("body").press("Space"); // lock
  await control.waitForTimeout(150);
  await control.locator("body").press("Space"); // reveal
  // 100 base (time decay down to 50) × 3: between 150 and 300.
  await expect.poll(async () => {
    const st = (await (await request.get(`/api/v1/state?t=${controlToken()}`)).json()) as { top: { name: string; total: number }[] }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own endpoint
    return st.top.find((r) => r.name === "Zoé")?.total ?? 0;
  }).toBeGreaterThanOrEqual(150);
  await control.locator("body").press("Space"); // next question
  await control.waitForTimeout(150);
  await control.locator("body").press("Space"); // present
  await expect(output.locator(".q-stakes-onair")).toHaveCount(0); // stakes were for that question only
  expect(errors).toEqual([]);
});
