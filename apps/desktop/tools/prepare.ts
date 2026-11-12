/**
 * Prepares the desktop package (ADR-0014): everything Tauri ships next to the launcher.
 *   src-tauri/binaries/quiz-node-<triple>.exe  the official Node runtime running the build (same version as dev)
 *   src-tauri/resources/server/main.mjs        the show server, bundled by esbuild (dev keeps type stripping)
 *   src-tauri/resources/server/node_modules/better-sqlite3   native SQLite (prebuilt N-API binary)
 *   src-tauri/resources/server/node_modules/sharp, @img/…    image tiles of « Image dévoilée » (prebuilt libvips)
 *   src-tauri/resources/apps/<name>/dist       the built front-ends (run `pnpm build` first)
 * Run: node tools/prepare.ts (from apps/desktop).
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const here = import.meta.dirname;
const repo = join(here, "..", "..", "..");
const tauri = join(here, "..", "src-tauri");
const resources = join(tauri, "resources");
const APPS = ["hub", "control", "host", "player", "output", "studio"] as const;

const triple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
rmSync(resources, { recursive: true, force: true });
mkdirSync(join(resources, "server", "node_modules"), { recursive: true });
mkdirSync(join(tauri, "binaries"), { recursive: true });

// 1. Node runtime as the Tauri sidecar (externalBin needs the target-triple suffix).
cpSync(process.execPath, join(tauri, "binaries", `quiz-node-${triple}${process.platform === "win32" ? ".exe" : ""}`));

// 2. Server bundle. CommonJS dependencies (fastify, ws…) inside an ESM bundle need `require`.
await build({
  entryPoints: [join(repo, "apps", "server", "src", "main.ts")],
  outfile: join(resources, "server", "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  external: ["better-sqlite3", "sharp"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: "external",
  logLevel: "warning",
});

// 3. better-sqlite3 (only what runs: lib, package.json, the prebuilt binary of this platform).
const req = createRequire(join(repo, "apps", "server", "package.json"));
const sqliteDir = dirname(req.resolve("better-sqlite3/package.json"));
const dest = join(resources, "server", "node_modules", "better-sqlite3");
for (const part of ["package.json", "lib", "LICENSE"]) cpSync(join(sqliteDir, part), join(dest, part), { recursive: true });
const prebuild = `${process.platform}-${process.arch}.node`;
mkdirSync(join(dest, "prebuilds"), { recursive: true });
cpSync(join(sqliteDir, "prebuilds", prebuild), join(dest, "prebuilds", prebuild));

// 3b. sharp and what it loads at run time (its JS deps, the prebuilt binary + libvips of this platform): pnpm keeps
// them side by side next to the real sharp folder; copied as plain folders (no links). Types are not needed.
const sharpDir = realpathSync(join(repo, "apps", "server", "node_modules", "sharp"));
const sharpDeps = dirname(sharpDir);
for (const name of readdirSync(sharpDeps)) {
  if (name === "@types") continue;
  cpSync(join(sharpDeps, name), join(resources, "server", "node_modules", name), { recursive: true, dereference: true });
}
// The copy must be enough on its own: load sharp from the package folder (fails here, not on the show machine).
const shipped = createRequire(join(resources, "server", "main.mjs"));
if (typeof shipped("sharp") !== "function") throw new Error("sharp copié mais inutilisable dans le paquet");

// 4. Front-ends.
for (const name of APPS) {
  const dist = join(repo, "apps", name, "dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error(`apps/${name}/dist manquant : lancer \`pnpm build\` à la racine d'abord`);
  cpSync(dist, join(resources, "apps", name, "dist"), { recursive: true });
}
// 5. Smoke test: the bundle starts ALONE (no repo node_modules on its path) and serves the home page + health.
const smokeDir = mkdtempSync(join(tmpdir(), "quiz-smoke-"));
const port = 47_000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, [join(resources, "server", "main.mjs")], {
  env: { ...process.env, QUIZ_DATA_DIR: smokeDir, QUIZ_APPS_DIR: join(resources, "apps"), QUIZ_PORT: String(port), QUIZ_LOG_LEVEL: "warn", QUIZ_HOST: "127.0.0.1" },
  stdio: "ignore",
});
try {
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const home = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
    ok = home?.status === 200 && (await home.text()).includes("/apps/hub/");
  }
  if (!ok) throw new Error("test de fumée : le serveur groupé ne démarre pas seul");
  if (!(await fetch(`http://127.0.0.1:${port}/health`)).ok) throw new Error("test de fumée : /health en échec");
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(smokeDir, { recursive: true, force: true });
}
process.stdout.write(`paquet prêt et vérifié pour ${triple}\n`);
