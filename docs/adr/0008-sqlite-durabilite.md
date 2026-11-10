# ADR-0008 — SQLite : WAL + `synchronous=FULL`, better-sqlite3

- Statut : accepté
- Date : 2026-11-10

## Contexte
Règle « journal avant diffusion ». Vérifié dans la doc officielle :
- https://www.sqlite.org/pragma.html#pragma_synchronous — « A transaction committed in WAL mode with
  synchronous=NORMAL might roll back following a power loss or system crash. » ; « FULL is atomic, consistent,
  isolated, and durable (ACID) in WAL mode ».
- https://www.sqlite.org/wal.html — « Writers sync the WAL on every transaction commit if PRAGMA synchronous is set to FULL ».

## Décision
- Journal en `journal_mode=WAL` + `synchronous=FULL`. Un `ack` ou une diffusion n'a lieu qu'après le commit.
- Pilote : `better-sqlite3` (API synchrone, v13, `engines.node >=22`). `node:sqlite` (Stability 1.2 — release
  candidate, https://nodejs.org/api/sqlite.html) est surveillé : il supprimerait l'addon natif au packaging
  (ADR-0006). Le port `EventStore` permet de changer de pilote sans toucher au reste.

## Alternatives écartées
- `synchronous=NORMAL` : plus rapide, mais une action déjà diffusée peut disparaître après une coupure de courant.

## Conséquences
Un fsync par transaction. Mesuré (2026-11-11) : avec un fsync par réponse, 100 réponses simultanées donnaient une
latence d'ack médiane de 425 ms. **Group commit implémenté** : les intentions d'un même tour de boucle partagent une
transaction → médiane ≈ 15 ms à 500 tablettes. `synchronous` reste à `FULL`.
