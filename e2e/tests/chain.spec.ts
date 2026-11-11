import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * « La chaîne » played end to end with 3 players (ADR-0016): « À vous » only on the tablet whose turn it is, bank from
 * the tablet and from the host, a wrong answer drops the chain, « Fin de la manche », the secret elimination vote with a
 * tie settled by the strongest link on their tablet, then the final duel and its winner taking the bank.
 */

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

type Frames = { all: string[] };

async function open(browser: Browser, url: string, viewport: { width: number; height: number }, errors: string[], frames?: Frames): Promise<Page> {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 1300 });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${url.split("?")[0]} → ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${url.split("?")[0]} → ${m.text()}`); });
  if (frames !== undefined) page.on("websocket", (ws) => ws.on("framereceived", (f) => { if (typeof f.payload === "string") frames.all.push(f.payload); }));
  await page.goto(url);
  return page;
}

test("chain: turns, bank, wrong answer, end of round, secret vote with tie-break, duel winner takes the bank", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  expect((await request.post(`/api/games/g_e2e_chaine/launch?t=${token("control")}&players=new`)).status()).toBe(200);
  const control = await open(browser, path("control"), { width: 1600, height: 1000 }, errors);
  await expect(control.getByText("connecté").first()).toBeVisible();
  await control.getByText("Importer des joueurs").click();
  await control.locator(".c-csv textarea").fill("Ana;1\nBo;2\nCy;3");
  await control.getByRole("button", { name: "Importer", exact: true }).click();
  await expect(control.getByText(/joueur\(s\) importé\(s\)/)).toBeVisible();
  const output = await open(browser, path("out-program"), { width: 1920, height: 1080 }, errors);
  const host = await open(browser, path("host"), { width: 1280, height: 800 }, errors);
  // Ana on a phone (360 px), Bo and Cy on tablets.
  const sizes = [{ width: 360, height: 740 }, { width: 800, height: 1280 }, { width: 600, height: 960 }];
  const frames: Frames[] = [];
  const tablets: Page[] = [];
  for (let i = 0; i < 3; i++) {
    const f: Frames = { all: [] };
    const page = await open(browser, path(`seat-${i + 1}`), sizes[i] ?? { width: 600, height: 960 }, errors, f);
    await page.getByText("Touchez l'écran pour commencer").click();
    tablets.push(page);
    frames.push(f);
  }
  const [ana, bo, cy] = tablets;
  if (ana === undefined || bo === undefined || cy === undefined) throw new Error("three tablets");
  const key = control.locator(".c-next");
  /** The next-step key: checks what it says, then presses it. */
  const step = async (label: RegExp | string) => {
    await expect(key).toContainText(label);
    await expect(key).toBeEnabled();
    await key.click();
  };
  const panel = control.locator(".q-chain");
  const turn = control.getByTestId("chain-turn");

  await step("Démarrer la partie");
  await step("Démarrer la manche");
  await step("Présenter la question");

  // Q1 — Ana's turn: « À vous » on her phone only; nothing to bank yet.
  await expect(turn).toHaveText("Ana");
  await expect(ana.getByTestId("chain-mine")).toBeVisible();
  await expect(ana.getByRole("button", { name: /Banque/ })).toBeDisabled();
  for (const other of [bo, cy]) {
    await expect(other.getByTestId("chain-other")).toHaveText("C'est au tour de Ana");
    await expect(other.getByText("À vous")).toHaveCount(0);
    await expect(other.getByRole("button", { name: /Banque/ })).toHaveCount(0);
  }
  // The expected answer is the host's and the control room's only.
  await expect(control.getByText("Réponse attendue : Mars")).toBeVisible();
  await expect(host.getByTestId("host-chain-turn")).toHaveText("Ana");
  await expect(key).toBeDisabled(); // « D'abord : Juste ou Faux »
  // Companion / OSC / HTTP `next` is the same key: refused with the same reason (never open / lock / reveal here).
  const api = await request.post("/api/v1/next", { headers: { authorization: `Bearer ${token("control")}` } });
  expect(await api.json()).toMatchObject({ ok: false, reason: "D'abord : Juste ou Faux" });
  // No stakes, no forced verdicts on a chain question: their panels are not offered.
  await expect(control.locator(".c-stakes")).toHaveCount(0);
  await panel.getByRole("button", { name: "✓ Juste" }).click();
  await expect(output.locator(".q-chain-step[data-state='current']")).toHaveText("20");
  await ana.screenshot({ path: "screenshots/chain-phone-turn.png" });
  await step("Question suivante");
  await step("Présenter la question");

  // Q2 — Bo banks 20 from his tablet, then the host judges him right: the chain climbs again from 0.
  await expect(turn).toHaveText("Bo");
  await expect(bo.getByTestId("chain-mine")).toBeVisible();
  await expect(ana.getByTestId("chain-mine")).toHaveCount(0);
  // A bank by the control room for Bo, taken back with « Annuler » (Ctrl+Z).
  await panel.getByRole("button", { name: "Banque 20" }).click();
  await expect(control.getByTestId("chain-bank")).toHaveText("20");
  await control.getByRole("button", { name: "↶ Annuler" }).click();
  await expect(control.getByTestId("chain-bank")).toHaveText("0");
  await bo.getByRole("button", { name: "Banque ! (20)" }).click();
  await expect(bo.getByText("Mis en banque ✓ 20")).toBeVisible();
  await expect(control.getByTestId("chain-bank")).toHaveText("20");
  await expect(output.locator(".q-chain-bank")).toContainText("20");
  await bo.screenshot({ path: "screenshots/chain-tablet-banked.png" });
  await host.getByRole("button", { name: "✓ Juste" }).click();
  await expect(output.locator(".q-chain-step[data-state='current']")).toHaveText("20");
  await host.screenshot({ path: "screenshots/chain-host.png" });
  await step("Question suivante");
  await step("Présenter la question");

  // Q3 — Cy is wrong: the chain falls back to 0, the bank stays.
  await expect(turn).toHaveText("Cy");
  await panel.getByRole("button", { name: "✗ Faux" }).click();
  await expect(output.locator(".q-chain-step[data-state='current']")).toHaveCount(0);
  await expect(output.locator(".q-chain-turn")).toHaveAttribute("data-verdict", "wrong");
  await expect(panel.getByText("Chaîne à zéro")).toBeVisible();
  await expect(cy.getByText("✗ Faux…")).toBeVisible();
  await output.screenshot({ path: "screenshots/chain-output-turn.png" });
  await control.screenshot({ path: "screenshots/chain-control.png", fullPage: true });

  // Time is up: « Fin de la manche » (confirmed), then « Suivante » ends the round.
  await panel.getByRole("button", { name: "Fin de la manche" }).click();
  await control.getByRole("dialog").getByRole("button", { name: "Fin de la manche" }).click();
  await expect(panel.getByText(/Temps écoulé/)).toBeVisible();
  await step("Fin de la manche");
  await expect(output.locator(".q-chain-board")).toContainText("Maillon fort");

  // Vote: each tablet votes against another player; secret on air until closed.
  await step("Ouvrir le vote d'élimination");
  await expect(ana.getByRole("heading", { name: "Qui doit quitter la partie ?" })).toBeVisible();
  await expect(ana.getByRole("button", { name: "Ana", exact: true })).toHaveCount(0); // never against oneself
  await ana.getByRole("button", { name: "Cy", exact: true }).click();
  await expect(ana.getByText("Vote enregistré ✓ contre Cy")).toBeVisible();
  await bo.getByRole("button", { name: "Ana", exact: true }).click();
  await expect(bo.getByText("Vote enregistré ✓ contre Ana")).toBeVisible();
  await cy.getByRole("button", { name: "Bo", exact: true }).click();
  await expect(cy.getByText("Vote enregistré ✓ contre Bo")).toBeVisible();
  await expect(control.getByTestId("chain-cast")).toHaveText("3 / 3");
  await expect(output.locator(".q-chain-vote-open")).toContainText("3 / 3");
  await expect(output.locator(".q-chain-tally")).toHaveCount(0);
  // No tablet ever received someone else's ballot while the vote was open.
  for (const f of frames) expect(f.all.some((x) => /"ballots":\[\{/.test(x))).toBe(false);
  await ana.screenshot({ path: "screenshots/chain-phone-vote.png" });

  // 1-1-1: tie. Bo, strongest link (as many right as Ana, more banked), picks on his tablet.
  await step("Clore le vote (3/3 votes)");
  await expect(bo.getByRole("heading", { name: "Égalité : à vous de choisir" })).toBeVisible();
  await expect(ana.getByText(/Bo, maillon fort de la manche, choisit/)).toBeVisible();
  await expect(bo.getByRole("button", { name: "Bo", exact: true })).toHaveCount(0);
  await bo.screenshot({ path: "screenshots/chain-tablet-tie.png" });
  await bo.getByRole("button", { name: "Cy", exact: true }).click();
  await expect(cy.getByTestId("chain-out")).toHaveText("Vous quittez la partie");
  await expect(control.getByTestId("chain-eliminated")).toContainText("Cy quitte la partie");
  await expect(output.locator(".q-chain-out")).toHaveText("Cy quitte la partie");
  await expect(output.locator(".q-chain-tally")).toHaveCount(3);
  await output.screenshot({ path: "screenshots/chain-output-vote.png" });

  // The final duel (round 3), started from the run-down.
  await control.locator(".c-round").filter({ hasText: "Duel final" }).getByRole("button", { name: "Démarrer" }).click();
  // The new round is not played yet: the vote result leaves the air (bank of the game and players still in).
  await expect(output.locator(".q-chain-board[data-fresh='true']")).toContainText("Duel final");
  await expect(output.locator(".q-chain-out")).toHaveCount(0);
  await expect(output.locator(".q-chain-board")).not.toContainText("Cy");
  await step("Présenter la question");
  await expect(cy.getByText("Vous avez quitté la partie")).toBeVisible();
  for (let i = 0; i < 10; i++) {
    const who = await turn.textContent();
    await panel.getByRole("button", { name: who === "Ana" ? "✓ Juste" : "✗ Faux" }).click();
    // Judged: the key moves on (next question, or the end of the game once the duel is decided).
    await expect(key).not.toContainText("D'abord");
    if ((await key.textContent())?.includes("Fin de la partie") === true) break;
    await step("Question suivante");
    await step("Présenter la question");
  }
  await expect(control.getByTestId("chain-winner")).toContainText("Ana gagne le duel et remporte la cagnotte (20)");
  await expect(output.locator(".q-chain-turn")).toContainText("Ana");
  await expect(output.locator(".q-chain-turn")).toContainText("remporte 20");
  await output.screenshot({ path: "screenshots/chain-output-duel.png" });
  await step("Fin de la partie : la cagnotte au vainqueur");
  await expect(ana.getByTestId("chain-winner")).toHaveText("Vous remportez la cagnotte : 20 !");
  await expect(bo.getByTestId("chain-winner")).toHaveText("Ana remporte la cagnotte (20)");
  await expect(ana.locator(".p-score")).toContainText("20 pts");
  await ana.screenshot({ path: "screenshots/chain-phone-winner.png" });
  expect(errors).toEqual([]);
});

test("chain: a duel whose questions run out can be ended without a winner (the bank is not paid)", async ({ browser, request }) => {
  const errors: string[] = [];
  expect((await request.post(`/api/games/g_e2e_chaine/launch?t=${token("control")}&players=new`)).status()).toBe(200);
  const control = await open(browser, path("control"), { width: 1600, height: 1000 }, errors);
  await expect(control.getByText("connecté").first()).toBeVisible();
  await control.getByText("Importer des joueurs").click();
  await control.locator(".c-csv textarea").fill("Ana;1\nBo;2");
  await control.getByRole("button", { name: "Importer", exact: true }).click();
  await expect(control.getByText(/joueur\(s\) importé\(s\)/)).toBeVisible();
  const key = control.locator(".c-next");
  await key.click(); // Démarrer la partie
  await control.locator(".c-round").filter({ hasText: "Duel final" }).getByRole("button", { name: "Démarrer" }).click();
  await expect(key).toContainText("Présenter la question");
  await key.click();
  const panel = control.locator(".q-chain");
  await panel.getByRole("button", { name: "✓ Juste" }).click();
  await panel.getByRole("button", { name: "Terminer le duel sans vainqueur" }).click();
  await expect(control.getByRole("dialog")).toContainText("n'est pas versée");
  await control.getByRole("dialog").getByRole("button", { name: "Terminer le duel sans vainqueur" }).click();
  await expect(key).toContainText("Fin de la partie (duel sans vainqueur)");
  await key.click();
  await expect(control.locator(".c-phase")).toContainText("Fin de partie");
  expect(errors).toEqual([]);
});
