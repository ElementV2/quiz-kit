# Audit de l'architecture (v1, 10/11/2026)

Relecture du doc d'archi « Quiz Builder — Architecture ». Ce qui tient, ce qui était flou, et les décisions prises
pour que l'implémentation ne parte pas dans tous les sens.

## Ce qui tient

- Séparation en 4 couches (Contenu / Format / Scène / Entrées) avec le moteur comme seul pont.
- Zone = binding + états + interaction : c'est ce qui permet « cochable / affiché / caché » selon le jeu.
- Serveur autoritaire, journal append-only, snapshots, undo par rejeu.
- Vues filtrées par rôle (anti-triche), séquences + idempotence (zéro réponse perdue).
- Mode Show 100 % LAN, médias préchargés.
- Rendu identique studio / antenne (même `renderer`).

## Trous et risques corrigés

| # | Problème | Risque | Décision |
|---|---|---|---|
| A1 | « Formats libres » non bornés | Construire un langage de programmation, bugs en live | **Format = données déclaratives + mécaniques TS enregistrées** (ADR-0002). L'utilisateur assemble, il n'écrit pas de code. |
| A2 | Temps et aléatoire dans le moteur | Rejeu non déterministe, undo faux | Moteur pur. Timers gérés par le serveur qui injecte `timer.expired`. Seed RNG stockée dans la session. |
| A3 | Projections par rôle pas spécifiées | Fuite de la bonne réponse | `project(state, viewer)` dans `engine`, tests « no-leak » obligatoires sur chaque mécanique. |
| A4 | Concurrence des actions | Deux validations simultanées, état incohérent | **Un seul writer** : file d'actions sérialisée dans le serveur, traitement une par une. |
| A5 | Durabilité SQLite floue | Perte de la dernière action sur coupure de courant | Journal en WAL ; régler `synchronous` pour survivre à une coupure de courant (vérifier la doc SQLite sur WAL + `synchronous=FULL` vs `NORMAL` et mesurer le coût). |
| A6 | Versions des fichiers jeu | Un jeu sauvegardé ne s'ouvre plus après mise à jour | `schemaVersion` sur chaque document + migrations dans `packages/schema`. |
| A7 | Médias sans identité | Cache incohérent, doublons | Stockage **adressé par hash** (SHA-256), préchargement par liste de hashes. |
| A8 | Score = nombre | Corrections manuelles non traçables | Score = **registre** de `ScoreEntry`, total calculé. |
| A9 | Sorties qui calculent | Divergences entre écrans | Les fronts ne font que rendre des vues projetées. Aucune règle de jeu côté client. |
| A10 | Packaging Tauri + sidecar Node dès le début | Complexité avant d'avoir un show | Phases 0 à 3 : `pnpm start` + navigateur. Tauri en phase 4 (ADR-0006). |
| A11 | Effets WebGL dans OBS / vMix non mesurés | Saccades à l'antenne | Niveaux de qualité des effets + bench en phase 2 avant d'en faire un défaut. |
| A12 | Infos non vérifiées (transparence vMix, EBU R 95, écriture PSD) | Promesse fausse | Listées dans `OPEN-QUESTIONS.md`, à vérifier avant de les implémenter. |

## Conventions

Le doc ne parlait pas de conventions de code : elles sont maintenant dans `CONVENTIONS.md`,
avec les principes SOLID appliqués concrètement au projet (et pas en théorie).
