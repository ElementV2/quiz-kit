import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Accessibility (WCAG 2.2 AA, axe-core) + responsive audit of every screen at phone / tablet / desktop sizes.
 * Measures only (never fails): writes e2e/audit/report.json. Run with AUDIT=1 (not part of the normal suite).
 */

test.skip(process.env["AUDIT"] !== "1", "audit: AUDIT=1 pnpm exec playwright test audit");
test.setTimeout(600_000);

type Links = { entries: { id: string; path: string }[] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- file written by apps/server/tools/e2e-server.ts
const links = (): Links => JSON.parse(readFileSync(join(import.meta.dirname, "..", ".links.json"), "utf8")) as Links;
const path = (id: string): string => links().entries.find((e) => e.id === id)?.path ?? "";
const token = (id: string): string => path(id).split("t=")[1] ?? "";

const SIZE_NAMES = ["phone", "phone-landscape", "tablet-portrait", "tablet-landscape", "laptop", "desktop"] as const;
const SIZES = {
  "phone": { width: 360, height: 740 },
  "phone-landscape": { width: 740, height: 360 },
  "tablet-portrait": { width: 800, height: 1280 },
  "tablet-landscape": { width: 1280, height: 800 },
  "laptop": { width: 1366, height: 768 },
  "desktop": { width: 1920, height: 1080 },
} as const;
type Size = keyof typeof SIZES;

type Finding = { screen: string; size: Size; axe: { id: string; impact: string | null; nodes: number; help: string; sample: string[] }[]; overflowX: number; smallTargets: { count: number; sample: string[] }; lang: string | null; focusVisible: boolean | null; title: string };
const report: Finding[] = [];

async function measure(page: Page, screen: string, size: Size): Promise<void> {
  await page.waitForTimeout(400);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const dom = await page.evaluate(() => {
    const overflowX = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
    const small: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=switch], [role=tab]")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none") continue;
      const inline = el.tagName === "A" && st.display === "inline";
      if (!inline && (r.width < 24 || r.height < 24)) small.push(`${el.tagName.toLowerCase()}${el.className ? "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".") : ""} ${Math.round(r.width)}×${Math.round(r.height)} « ${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 24)} »`);
    }
    return { overflowX, small, lang: document.documentElement.getAttribute("lang"), title: document.title };
  });
  // Keyboard focus visible: Tab to the first focusable and look at its outline / shadow.
  let focusVisible: boolean | null = null;
  try {
    await page.keyboard.press("Tab");
    focusVisible = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) return null;
      const st = getComputedStyle(el);
      return (st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0) || (st.boxShadow !== "none" && st.boxShadow !== "");
    });
  } catch {
    focusVisible = null;
  }
  report.push({
    screen,
    size,
    axe: axe.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length, help: v.help, sample: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })),
    overflowX: dom.overflowX,
    smallTargets: { count: dom.small.length, sample: dom.small.slice(0, 6) },
    lang: dom.lang,
    focusVisible,
    title: dom.title,
  });
}

async function open(browser: Browser, url: string, size: Size): Promise<Page> {
  const ctx = await browser.newContext({ viewport: SIZES[size], hasTouch: SIZES[size].width < 1000 });
  const page = await ctx.newPage();
  await page.goto(url);
  return page;
}

test("audit: accessibility and responsive, every screen, every size", async ({ browser, request }) => {
  expect((await request.post(`/api/games/g_e2e_qcm/launch?t=${token("control")}&players=new`)).status()).toBe(200);
  // Static screens first.
  for (const size of SIZE_NAMES) {
    const hub = await open(browser, "/", size);
    await measure(hub, "accueil", size);
    await hub.context().close();
    const play = await open(browser, "/play", size);
    await measure(play, "play (rejoindre)", size);
    await play.context().close();
    const seat = await open(browser, path("seat-1"), size);
    await seat.getByText("Touchez l'écran pour commencer").click();
    await measure(seat, "siège libre", size);
    await seat.context().close();
  }
  // Live screens: a QCM on air, one player seated.
  const control = await open(browser, path("control"), "laptop");
  await expect(control.getByText("connecté").first()).toBeVisible();
  await control.getByText("Importer des joueurs").click();
  await control.locator(".c-csv textarea").fill("Ana;1\nBo;2");
  await control.getByRole("button", { name: "Importer", exact: true }).click();
  for (let i = 0; i < 4; i++) {
    await control.locator("body").press("Space");
    await control.waitForTimeout(200);
  }
  for (const size of ["laptop", "desktop", "tablet-landscape"] as const) {
    const c = await open(browser, path("control"), size);
    await measure(c, "régie (QCM à l'antenne)", size);
    await c.context().close();
  }
  for (const size of SIZE_NAMES) {
    const host = await open(browser, path("host"), size);
    await measure(host, "animateur (QCM à l'antenne)", size);
    await host.context().close();
    const seat = await open(browser, path("seat-1"), size);
    await seat.getByText("Touchez l'écran pour commencer").click();
    await measure(seat, "tablette joueur (QCM ouvert)", size);
    await seat.context().close();
  }
  const out = await open(browser, path("out-program"), "desktop");
  await measure(out, "sortie programme", "desktop");
  await out.context().close();
  for (const size of ["laptop", "desktop", "tablet-landscape"] as const) {
    const studio = await open(browser, path("studio"), size);
    await studio.locator(".s-game-open").filter({ hasText: /^E2E — QCM \(3 questions\)$/ }).click();
    await measure(studio, "studio — Contenu", size);
    await studio.getByRole("button", { name: "Format", exact: true }).click();
    await measure(studio, "studio — Format", size);
    await studio.context().close();
  }
  mkdirSync(join(import.meta.dirname, "..", "audit"), { recursive: true });
  writeFileSync(join(import.meta.dirname, "..", "audit", "report.json"), JSON.stringify(report, null, 2));
});
