/** Allowed internal dependencies per workspace package (ADR-0007). */
export const ALLOWED_DEPS: Readonly<Record<string, readonly string[]>> = {
  "@quiz/schema": [],
  "@quiz/engine": ["@quiz/schema"],
  "@quiz/protocol": ["@quiz/schema"],
  "@quiz/server": ["@quiz/schema", "@quiz/engine", "@quiz/protocol"],
  "@quiz/renderer": ["@quiz/schema"],
  "@quiz/ui": ["@quiz/schema", "@quiz/protocol"],
  "@quiz/control": ["@quiz/schema", "@quiz/protocol", "@quiz/renderer", "@quiz/ui"],
  "@quiz/host": ["@quiz/schema", "@quiz/protocol", "@quiz/renderer", "@quiz/ui"],
  "@quiz/player": ["@quiz/schema", "@quiz/protocol", "@quiz/renderer", "@quiz/ui"],
  "@quiz/output": ["@quiz/schema", "@quiz/protocol", "@quiz/renderer", "@quiz/ui"],
  "@quiz/studio": ["@quiz/schema", "@quiz/protocol", "@quiz/renderer", "@quiz/ui", "@quiz/engine"],
  "@quiz/scripts": [],
};

export type Manifest = {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
};

/** Returns one human-readable violation per forbidden or unknown edge. */
export function checkDeps(manifests: readonly Manifest[]): string[] {
  const violations: string[] = [];
  for (const m of manifests) {
    const allowed = ALLOWED_DEPS[m.name];
    if (allowed === undefined) {
      violations.push(`${m.name}: paquet absent du graphe autorisé (scripts/src/dep-graph.ts)`);
      continue;
    }
    const all = { ...m.dependencies, ...m.devDependencies, ...m.peerDependencies };
    for (const dep of Object.keys(all)) {
      if (dep.startsWith("@quiz/") && !allowed.includes(dep)) {
        violations.push(`${m.name} → ${dep} : dépendance interdite (ADR-0007)`);
      }
    }
  }
  return violations;
}
