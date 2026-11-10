import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkDeps, type Manifest } from "./src/dep-graph.ts";

const root = join(import.meta.dirname, "..");
const dirs = ["packages", "apps"].flatMap((d) =>
  existsSync(join(root, d)) ? readdirSync(join(root, d)).map((n) => join(root, d, n)) : [],
);
dirs.push(join(root, "scripts"));

const manifests: Manifest[] = dirs
  .filter((d) => existsSync(join(d, "package.json")))
  .map((d) => toManifest(JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as unknown, d));

function toManifest(raw: unknown, dir: string): Manifest {
  if (typeof raw !== "object" || raw === null || !("name" in raw) || typeof raw.name !== "string") {
    throw new Error(`package.json sans nom : ${dir}`);
  }
  const deps = (key: string): Record<string, string> => {
    const v: unknown = (raw as Record<string, unknown>)[key]; // narrowed to object above
    return typeof v === "object" && v !== null ? Object.fromEntries(Object.keys(v).map((k) => [k, ""])) : {};
  };
  return {
    name: raw.name,
    dependencies: deps("dependencies"),
    devDependencies: deps("devDependencies"),
    peerDependencies: deps("peerDependencies"),
  };
}

const violations = checkDeps(manifests);
if (violations.length > 0) {
  for (const v of violations) console.error(`✗ ${v}`);
  process.exit(1);
}
console.log(`✓ graphe de dépendances conforme (${manifests.length} paquets)`);
