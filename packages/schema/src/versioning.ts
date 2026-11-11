import { GameDocument } from "./session.ts";
import { toMixedRounds } from "./upgrade.ts";

export const CURRENT_SCHEMA_VERSION = 1;

/** A pure migration from version `from` to `from + 1`. */
export type Migration = { readonly from: number; readonly migrate: (doc: Record<string, unknown>) => Record<string, unknown> };

/** Ordered migrations. Add `{ from: 1, migrate }` when version 2 appears, with fixtures in versioning.test.ts. */
export const MIGRATIONS: readonly Migration[] = [];

export type LoadError =
  | { readonly code: "not-an-object" }
  | { readonly code: "missing-version" }
  | { readonly code: "future-version"; readonly version: number }
  | { readonly code: "missing-migration"; readonly from: number }
  | { readonly code: "invalid"; readonly issues: readonly string[] };

export type LoadResult = { readonly ok: true; readonly value: GameDocument } | { readonly ok: false; readonly error: LoadError };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Migrates any known older version up to CURRENT_SCHEMA_VERSION, then validates (boundary: imported files, DB).
 * One-kind rounds become « Mixte » (`toMixedRounds`, ADR-0015) unless `upgradeRounds: false` (a live edit of a
 * session launched before must keep its round types).
 */
export function loadGameDocument(raw: unknown, migrations: readonly Migration[] = MIGRATIONS, opts: { readonly upgradeRounds?: boolean } = {}): LoadResult {
  if (!isRecord(raw)) return { ok: false, error: { code: "not-an-object" } };
  let doc = raw;
  const declared = doc["schemaVersion"];
  if (typeof declared !== "number" || !Number.isInteger(declared)) return { ok: false, error: { code: "missing-version" } };
  let version: number = declared;
  if (version > CURRENT_SCHEMA_VERSION) return { ok: false, error: { code: "future-version", version } };
  while (version < CURRENT_SCHEMA_VERSION) {
    const from: number = version;
    const m = migrations.find((x) => x.from === from);
    if (m === undefined) return { ok: false, error: { code: "missing-migration", from } };
    doc = { ...m.migrate(doc), schemaVersion: from + 1 };
    version = from + 1;
  }
  const parsed = GameDocument.safeParse(doc);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
  }
  return { ok: true, value: opts.upgradeRounds === false ? parsed.data : toMixedRounds(parsed.data) };
}
