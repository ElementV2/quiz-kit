# ADR-0014 — Paquet desktop : lanceur Tauri 2 + Node officiel en sidecar + serveur groupé

- Statut : accepté (remplace la question ouverte de l'ADR-0006 : « Node SEA ou bun build --compile »)
- Date : 2026-11-11

## Contexte
Phase 4 : installer le serveur de show sur un PC sans outils de dev. Vérifié (nodejs.org, v2.tauri.app, le
2026-11-11) : Node SEA est en stabilité 1.1, n'exécute qu'un seul fichier qui ne charge que des modules
intégrés, et ne peut pas charger un addon natif depuis l'exécutable — or le journal utilise `better-sqlite3`
(addon N-API, binaires précompilés fournis). `node:sqlite` est en 1.2 (release candidate), pas stable.
Le type stripping de Node ne s'applique pas aux fichiers sous `node_modules` : livrer les paquets du monorepo
tels quels dans un `node_modules` ne fonctionne pas.

## Décision
- Lanceur **Tauri 2** (dernière stable 2.x ; la 3 est en alpha) : `apps/desktop`. Il démarre le serveur,
  le **relance lui-même** s'il s'arrête (pas de superviseur Node : aucun processus petit-enfant orphelin),
  affiche l'accueil (`http://localhost:7300/`) dès que le port répond, et arrête le serveur à la fermeture.
- Sidecar = le **`node.exe` officiel** de la version de dev (`.node-version`), suffixé du triple cible.
- Serveur **groupé par esbuild** en un `main.mjs` (dépendances CommonJS via `createRequire`), `better-sqlite3`
  copié à côté (lib + binaire précompilé de la plateforme). Le code de dev ne change pas (ADR-0011 : TypeScript
  exécuté directement) ; seul l'artefact du paquet est groupé.
- Front-ends copiés dans les ressources ; le serveur les trouve via `QUIZ_APPS_DIR`. Données dans le dossier
  de données de l'application (`%APPDATA%\fr.quizkit.desktop\show`).
- Préparation : `pnpm build` puis `pnpm --filter @quiz/desktop package` (`tools/prepare.ts` + `tauri build`).

## Alternatives écartées
- Node SEA — pas stable, addon natif à extraire dans un dossier temporaire, bundle obligatoire de toute façon.
- `bun build --compile` — autre moteur que celui testé en dev et en charge (Node 26), compatibilité
  `better-sqlite3` à revalider.
- Passer à `node:sqlite` — pas encore stable ; à réévaluer quand il le sera (supprime l'addon natif).

## Conséquences
- L'installateur embarque ~100 Mo de Node. Mise à jour de Node = refaire le paquet.
- Le bundle doit être testé seul (sans `node_modules` du dépôt) : fait par `tools/prepare.ts` + essai à la main ;
  à automatiser en CI.
- Windows : WebView2 requis (présent sur Windows 10/11 à jour).
