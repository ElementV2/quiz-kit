# ADR-0007 — Actions et vues dans `schema`, graphe de dépendances corrigé

- Statut : accepté
- Date : 2026-11-10

## Contexte
Le graphe initial `schema ← engine ← protocol ← server` faisait dépendre `protocol` du moteur. Comme les apps
front utilisent `protocol/client`, elles embarquaient `engine`, ce qui contredit « le renderer ne connaît que des
vues projetées ». Les types `Action` et `View` n'avaient pas de paquet défini alors que le renderer s'y binde.

## Décision
- Les schémas Zod des **actions** (union discriminée) et des **vues par rôle** vivent dans `packages/schema`.
- Graphe : `schema ← engine`, `schema ← protocol`, `engine + protocol ← server`, `schema ← renderer ← apps`,
  `protocol ← apps` (client). Seul `apps/studio` peut importer `engine` (simulation d'états).
- Vérification : `scripts/check-deps.ts` compare les dépendances `@quiz/*` de chaque `package.json` au graphe
  autorisé (pnpm isole les `node_modules` : un import non déclaré échoue déjà à la résolution). Les imports
  profonds (`@quiz/x/src/...`) sont interdits par lint (`no-restricted-imports`).

## Alternatives écartées
- Garder les actions dans `engine` et créer un paquet `types` séparé : un paquet de plus sans gain.

## Conséquences
Les fronts n'embarquent jamais le moteur. `Round.mechanicConfig` reste `unknown` dans `schema` : c'est le moteur
qui le valide avec le schéma de la mécanique au chargement d'une session.
