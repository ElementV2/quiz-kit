# Conventions de code

## SOLID, appliqué à ce projet

| Principe | Ce que ça veut dire ici |
|---|---|
| **S** — responsabilité unique | Un paquet = une responsabilité (voir CLAUDE.md). Dans `engine`, une mécanique = un dossier (`mechanics/buzzer/`), qui gère ses actions, son score et sa projection, rien d'autre. Le serveur ne contient aucune règle de jeu. |
| **O** — ouvert/fermé | On ajoute un type de réponse ou une mécanique en **enregistrant** un module (`registerMechanic(buzzer)`), sans modifier le cœur du réducteur. Pareil pour les zones du renderer (`registerZone`) et les canaux d'entrée (`registerInput`). |
| **L** — substitution | Toute mécanique respecte le même contrat `Mechanic<Config, State, Action>` et passe la même suite de tests de contrat (`mechanicContractSuite`). Tout canal d'entrée (tablette, buzzer USB, chat Twitch) produit les mêmes actions `submit`, `buzz` ou `vote`. |
| **I** — interfaces ciblées | Une vue projetée par rôle (`PlayerView`, `HostView`, `OutputView`, `ControlView`), pas un gros état partagé. Un composant de zone reçoit uniquement la donnée bindée et son état. |
| **D** — inversion de dépendances | Le moteur reçoit son `Rng` et l'heure de l'événement (`ctx.at`) en paramètre ; il n'a pas de `Clock` (ADR-0010). Le serveur dépend de ports (`EventStore`, `MediaStore`, `Transport`) avec une implémentation SQLite / disque / ws, remplaçable en test par de la mémoire. |

Garde-fou : SOLID sert à rendre le code **simple à changer**, pas à multiplier les abstractions.
Pas d'interface tant qu'il n'y a pas au moins deux implémentations réelles ou un besoin de test.

## TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- Code exécuté par Node sans build (ADR-0011) : imports relatifs avec extension `.ts`, `import type` pour les
  types (`verbatimModuleSyntax`), syntaxe effaçable uniquement (`erasableSyntaxOnly` : pas d'`enum`,
  de `namespace` ni de parameter properties).
- Interdits : `any`, `as` non justifié (commentaire obligatoire), `!` non-null, `enum` TS (préférer unions de littéraux).
- Types dérivés des schémas Zod (`z.infer`), jamais dupliqués à la main.
- Données immuables dans le moteur (`readonly`, `ReadonlyArray`). Mises à jour par copie ; une lib
  comme Immer seulement si un ADR le valide.
- Unions discriminées pour actions, états et messages (`type: 'question.reveal'`), avec un `switch`
  exhaustif (`assertNever`).
- Erreurs métier = valeurs (`Result<T, E>`), pas d'exceptions. Exceptions réservées aux bugs.
- Validation Zod à **chaque frontière** : fichier importé, message réseau entrant, requête HTTP, lecture BDD.

## Nommage

- Fichiers en `kebab-case.ts`, composants Solid en `PascalCase.tsx`.
- Actions : `domaine.verbe` (`question.reveal`, `score.adjust`, `player.rename`).
- Événements journalisés = actions acceptées + `seq` + `at` (horodatage serveur) + `actor`.
- IDs : préfixe + ULID maison (`q_…`, `p_…`, `ses_…`), générés par le serveur ; IDs créés par le moteur
  dérivés de l'événement (ADR-0011).

## Structure d'un paquet

```
src/
  index.ts          API publique, seule importable depuis l'extérieur
  <module>/
    <module>.ts
    <module>.test.ts
```

Les imports profonds entre paquets sont interdits (lint : `no-restricted-imports` ou outil équivalent, à choisir).

## Tests

| Niveau | Outil | Obligatoire pour |
|---|---|---|
| Unitaire / scénario | Vitest | Toute mécanique, tout scoring, toute projection |
| Contrat | Vitest | Chaque mécanique (`mechanicContractSuite`) et chaque canal d'entrée |
| Propriétés | fast-check (ou équivalent, à valider) | Rejeu = état, undo(redo(x)) = x, aucune fuite dans `project()` |
| Intégration temps réel | Vitest + vrai serveur | Reconnexion, idempotence, resynchro |
| E2E visuel | Playwright | Scènes des templates (captures comparées) |
| Charge / chaos | k6 + scripts | Avant chaque fin de phase |

Un bug trouvé = d'abord un test qui le reproduit.

## Front (SolidJS)

- Signals et stores Solid, pas de lib d'état globale tant qu'aucun ADR ne le justifie.
- Un client WebSocket par app (`packages/protocol/client`), qui expose un store de la vue projetée.
- Aucune logique de jeu dans les apps : un bouton envoie une intention, point.
- Styles : variables CSS du thème (`--q-color-primary`…), unités en px sur les sorties (canvas fixe 1920×1080),
  responsive sur `player`.

## Git

- Conventional Commits, branches `feat/…`, `fix/…`.
- Une PR = une case de roadmap. Le `reviewer` passe sur `engine`, `protocol` et `server`.
- ADR pour toute décision difficile à défaire (lib structurante, format de données, protocole).
