# 01 — Architecture d'ensemble

## Les 4 couches

| Couche | Contenu | Paquet |
|---|---|---|
| Contenu | Questions, réponses, médias, sondages | `schema` (modèles), `server` (stockage) |
| Format | Manches, mécaniques, scoring, jokers | `schema` (config) + `engine` (exécution) |
| Scène | Zones bindées, états, couches, thèmes, moments | `schema` (modèle) + `renderer` (rendu) |
| Entrées | Régie, animateur, tablettes, buzzers, chat | `protocol` + `server/inputs` |

## Flux d'une action en live

```
 tablette / régie / buzzer / chat
        │  intention (submit, buzz, reveal…)
        ▼
 server/transport ── valide (Zod, rôle, rate limit, idempotence)
        │
        ▼
 server/game-loop  (FILE SÉRIALISÉE, un seul writer)
        │  1. engine.reduce(state, action)  → state' | rejet
        │  2. eventStore.append(event)       (SQLite, AVANT diffusion)
        │  3. pour chaque client : engine.project(state', viewer) → vue
        │  4. transport.send(diff ou snapshot, seq)
        ▼
 clients (renderer)  →  rendu de la vue, aucune règle de jeu
```

Le serveur gère aussi les **timers** : à échéance, il injecte `timer.expired` dans la file,
comme n'importe quelle action. Le moteur ne lit jamais l'horloge.

## Processus et déploiement

- **Show** : un seul process `apps/server` sur la machine show (filaire), qui sert aussi les
  apps front en statique. Tous les clients se connectent à `http://<ip-show>:<port>`.
- **Studio** : même serveur, en mode édition. Les jeux s'exportent / s'importent en fichier `.quiz`
  (zip : JSON + médias adressés par hash) pour passer d'une machine à l'autre.
- **Distance (interne)** : même serveur derrière le VPN de l'équipe. Jamais exposé publiquement.
- Phase 4 : machine de secours en hot standby qui suit le journal (voir `05-reliability.md`).

## Dépendances entre paquets

```
           ┌── engine ───┐
schema ◄───┤             ├──► server
           └── protocol ─┘
   ▲            ▲
   └ renderer ◄─┴── apps (control, host, player, output)        studio : + engine (simulation)
```

Les schémas des **actions** et des **vues par rôle** sont dans `schema` (ADR-0007) : `protocol` et le
`renderer` les connaissent sans dépendre du moteur. `studio` est le seul front autorisé à importer `engine`,
pour la **simulation d'états** (aperçu, mode Répétition).

## Rôles (viewers)

| Rôle | URL | Vue | Actions |
|---|---|---|---|
| `control` | `/control/<show>` | `ControlView` (tout) | toutes les actions régie |
| `control-readonly` | idem | `ControlView` | aucune |
| `host` | `/host/<show>` | `HostView` (bonne réponse, notes) | `answer.judge` si le format le permet |
| `output:<scene>` | `/out/<show>/<scene>` | `OutputView` (public) | aucune |
| `seat:<n>` | `/seat/<n>` | `PlayerView` du participant assis au siège n | réponses, buzz, vote |
| `player:<participantId>` | `/play/<code>` | `PlayerView` | réponses, buzz, vote |
| `studio` | `/studio` | édition | hors show |

La table d'autorisations est un schéma de `schema` (`actionPermissions`), vérifié par le serveur et par le moteur.
