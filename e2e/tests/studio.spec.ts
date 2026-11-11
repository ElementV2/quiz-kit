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
  await studio.getByRole("menuitem", { name: "QCM rapide (Kahoot-like)" }).click(); // the demo questions
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
  await studio.getByRole("button", { name: /^(Enregistr|Modifications|Non enregistré)/ }).click();
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

const px = (w: number, h: number, v = 200) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(v) });
const opaque = (w: number, h: number, [r, g, b]: [number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
  return { width: w, height: h, data };
};

test("studio design import: PSD named layers become zones, fonts / colours listed, trace a zone, eyedropper on the reference", async ({ browser }) => {
  const { writePsdBuffer } = await import("ag-psd");
  const psd = writePsdBuffer({
    width: 1920,
    height: 1080,
    imageData: opaque(1920, 1080, [40, 60, 200]), // flattened composite, what the eyedropper reads
    children: [
      { name: "Fond", left: 0, top: 0, imageData: px(1920, 1080, 18) },
      { name: "zone:question:titre", left: 96, top: 100, imageData: px(1728, 200) },
      { name: "zone:answer-list:choix", children: [{ name: "A", left: 96, top: 700, imageData: px(800, 120) }, { name: "B", left: 1000, top: 860, imageData: px(824, 120) }] },
      { name: "Titre", text: { text: "Bonjour", style: { font: { name: "Montserrat-Bold" }, fontSize: 64, fillColor: { r: 255, g: 204, b: 77 } } } },
    ],
  });
  const errors: string[] = [];
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const studio = await ctx.newPage();
  studio.on("pageerror", (e) => errors.push(e.message));
  studio.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await studio.goto(path("studio"));
  await studio.getByRole("button", { name: "+ Nouvelle" }).click();
  await studio.getByRole("menuitem", { name: /Partie vide/ }).click();
  await studio.getByRole("button", { name: "Scènes" }).click();
  await studio.getByRole("button", { name: "Personnaliser les scènes" }).click();
  // The 1920x1080 stage fills the canvas, also after leaving the tab and coming back (scale bug).
  const fills = () => studio.evaluate(() => {
    const c = document.querySelector(".s-canvas")?.getBoundingClientRect();
    const st = document.querySelector(".s-stage")?.getBoundingClientRect();
    return c !== undefined && st !== undefined && Math.abs(c.width - st.width) < 2 && Math.abs(c.height - st.height) < 2;
  });
  await expect.poll(fills).toBe(true);
  await studio.getByRole("button", { name: "Contenu" }).click();
  await studio.getByRole("button", { name: "Scènes" }).click();
  await expect.poll(fills).toBe(true);

  await studio.locator('input[type="file"][accept^=".psd"]').setInputFiles({ name: "maquette.psd", mimeType: "image/vnd.adobe.photoshop", buffer: psd });
  await expect(studio.getByText(/PSD 1920×1080 : 2 zone\(s\) créée\(s\)/)).toBeVisible();
  await expect(studio.locator(".s-zone").filter({ hasText: "titre" })).toHaveCount(1);
  await expect(studio.locator(".s-zone").filter({ hasText: "choix" })).toHaveCount(1);
  await expect(studio.getByRole("button", { name: /Montserrat-Bold · 64 px/ })).toBeVisible();

  // Trace a zone on the reference.
  const before = await studio.locator(".s-zone").count();
  await studio.getByRole("button", { name: "Tracer une zone" }).click();
  const box = await studio.locator(".s-canvas").boundingBox();
  if (box === null) throw new Error("canvas");
  await studio.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.4);
  await studio.mouse.down();
  await studio.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.55, { steps: 5 });
  await studio.mouse.up();
  await expect(studio.locator(".s-zone")).toHaveCount(before + 1);

  // Eyedropper on the flattened PSD composite.
  await studio.getByRole("button", { name: "Pipette" }).click();
  await studio.mouse.click(box.x + box.width * 0.5, box.y + box.height * (200 / 1080));
  await expect(studio.locator(".s-picked code")).toHaveText("#283cc8");
  await studio.screenshot({ path: "screenshots/studio-psd.png" });

  // PSD template export → re-import: every zone comes back from its layer name.
  const zonesBefore = await studio.locator(".s-zone").count();
  await studio.getByText("Gabarit pour le graphiste").click(); // folded section of the zone list
  const [dl] = await Promise.all([studio.waitForEvent("download"), studio.getByRole("button", { name: "Gabarit PSD (calques)" }).click()]);
  const file = await dl.path();
  await studio.locator('input[type="file"][accept^=".psd"]').setInputFiles(file);
  await expect(studio.getByText(`PSD 1920×1080 : ${zonesBefore} zone(s) créée(s)`)).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});

/** 0.2 s of silence, 48 kHz mono 16-bit PCM WAV. */
function silentWav(): Buffer {
  const samples = 9600;
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48_000, 24);
  b.writeUInt32LE(96_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#fff"/><rect x="10" y="10" width="110" height="80" fill="#e61e3c"/><rect x="130" y="10" width="60" height="80" fill="#145adc"/></svg>`;

test("studio theme: material, logo palette, sound pack — exported with the game and played on air with &sound=on", async ({ browser, request }) => {
  const errors: string[] = [];
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const studio = await ctx.newPage();
  studio.on("pageerror", (e) => errors.push(e.message));
  studio.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await studio.goto(path("studio"));
  await studio.getByRole("button", { name: "+ Nouvelle" }).click();
  await studio.getByRole("menuitem", { name: "QCM rapide (Kahoot-like)" }).click(); // the demo questions
  await studio.locator(".s-title").fill("Thème e2e");
  await studio.getByRole("button", { name: "+ QCM" }).click();
  await studio.getByRole("button", { name: "Thème" }).click();
  await studio.locator("label", { hasText: "Matériau des cadres" }).locator("select").selectOption("neon");
  await studio.locator('label:has-text("Logo…") input[type="file"]').setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from(LOGO) });
  await expect(studio.getByText("Couleurs du logo : #e61e3c, #145adc")).toBeVisible();
  await studio.locator(".s-sounds .s-row", { hasText: "Bonne réponse" }).locator('input[type="file"]').setInputFiles({ name: "bravo.wav", mimeType: "audio/wav", buffer: silentWav() });
  await expect(studio.locator(".s-sounds .s-row", { hasText: "Bonne réponse" }).getByRole("button", { name: "▶" })).toBeVisible();
  await studio.screenshot({ path: "screenshots/studio-theme-pack.png" });
  await studio.getByRole("button", { name: /^(Enregistr|Modifications|Non enregistré)/ }).click();
  await expect(studio.getByText("Enregistré", { exact: true }).first()).toBeVisible();

  const games = (await (await request.get(`/api/games?t=${token("studio")}`)).json()) as { games: { id: string; title: string }[] }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own endpoint
  const id = games.games.find((x) => x.title === "Thème e2e")?.id ?? "";
  // The .quiz archive carries the logo and the sound (studio graphics are media too).
  const archive = await request.get(`/api/games/${id}/export?t=${token("studio")}`);
  expect(archive.status()).toBe(200);
  const entries = (await archive.body()).toString("latin1").match(/media\/[0-9a-f]{64}(?=\.json)/g) ?? [];
  expect(new Set(entries).size).toBe(2);

  expect((await request.post(`/api/games/${id}/launch?t=${token("control")}`)).status()).toBe(200);
  const output = await ctx.newPage();
  output.on("pageerror", (e) => errors.push(e.message));
  await output.goto(`${path("out-program")}&sound=on`);
  await expect.poll(async () => output.locator(".q-scene").evaluate((el) => getComputedStyle(el).getPropertyValue("--q-mat-border").trim())).toMatch(/^2px solid #/); // neon: accent-coloured border
  const control = await ctx.newPage();
  await control.goto(path("control"));
  await expect(control.getByText("connecté").first()).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await control.locator("body").press("Space"); // start, round, present, open, lock, reveal
    await control.waitForTimeout(120);
  }
  await expect(output.locator('.q-answer[data-state="correct"]')).toHaveCount(1);
  // The correct-answer cue was triggered (played, or refused by the headless autoplay policy — never silent by bug).
  await expect(output.locator("[data-sound]")).not.toHaveAttribute("data-sound", "ready");
  await output.screenshot({ path: "screenshots/output-neon.png" });
  expect(errors).toEqual([]);
  await ctx.close();
});
