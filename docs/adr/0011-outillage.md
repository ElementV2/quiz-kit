# ADR-0011 — Outillage : TS 7 natif, oxlint, TS exécuté par Node, IDs maison

- Statut : accepté
- Date : 2026-11-10

## Contexte
Consigne : dernières versions stables. Registre npm au 2026-11-10 : `typescript@7.0.2` (latest), mais
`typescript-eslint@8.72.2` exige `typescript >=4.8.4 <6.1.0`.

## Décision
- **TypeScript 7.0** (portage natif) pour le typecheck.
- **oxlint** + **oxlint-tsgolint** (lint type-aware basé sur TS 7) à la place d'ESLint + typescript-eslint.
- **Pas d'étape de build pour le code Node** : Node exécute le TS par *type stripping*, stable depuis v24.12.0
  (https://nodejs.org/api/typescript.html — « Type stripping is now stable. » v25.2.0, v24.12.0). Donc : imports
  relatifs avec extension `.ts`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, pas d'`enum` ni de parameter
  properties. Les paquets exportent `./src/index.ts` (les workspaces pnpm sont des liens résolus hors
  `node_modules`, où Node refuse le TS).
- **Node 26.13 LTS** (« Lithium », dernière LTS au 2026-11-10 ; la v27 est en alpha), fixé par `.node-version`
  (fnm) et `engines.node >=26.13` avec `engineStrict: true`. better-sqlite3 fournit des binaires pour Node 26.
- **Vitest** pour les tests, **fast-check** pour les propriétés.
- **IDs** : `préfixe_` + ULID maison (48 bits ms + 80 bits aléatoires, Crockford base32) généré **par le serveur** ;
  les IDs créés par le moteur sont dérivés de l'événement (`se_<seq>_<n>`) pour rester déterministes.
- **k6** pour la charge (module `k6/websockets`, stable depuis k6 v1.6.0), avec `packages/protocol` bundlé par
  esbuild : k6 ne résout pas les modules Node (https://grafana.com/docs/k6/latest/using-k6/modules/).

## Alternatives écartées
- TS 6.0 + typescript-eslint : une version majeure de retard.
- Biome : moins de règles type-aware utiles ici (exhaustivité des `switch`).

## Conséquences
À surveiller : support de TS 7 dans typescript-eslint (retour possible à ESLint) et l'outillage Vite/Solid en phase 1.

Note : la règle `oxc/no-async-endpoint-handlers` (écrite pour Express) est désactivée pour `apps/server/src/http/**` : Fastify gère nativement les handlers async (une promesse rejetée devient une réponse d'erreur).
