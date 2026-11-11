import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E over the LAN IP, NOT localhost: localhost is a secure context and would hide any HTTPS-only API
 * slipping into the apps (tablets load plain http://<ip>, ADR-0012).
 */
const lanIp = Object.values(networkInterfaces()).flat().find((a) => a !== undefined && a.family === "IPv4" && !a.internal)?.address ?? "127.0.0.1";
const port = 7320;
export const LINKS_FILE = join(import.meta.dirname, ".links.json");

export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: { baseURL: `http://${lanIp}:${port}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node ../apps/server/tools/e2e-server.ts",
    env: { E2E_PORT: String(port), E2E_LINKS: LINKS_FILE },
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    stdout: "pipe",
    timeout: 30_000,
  },
});
