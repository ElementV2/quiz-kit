# 00 — Vision

Un outil interne pour créer **n'importe quel jeu de quiz** sans coder, l'habiller avec une vraie DA,
et le faire tourner en live avec une régie, un animateur, des participants sur tablettes / téléphones /
buzzers / chat, et des sorties 1920×1080 pour OBS et vMix.

L'app ne code pas des jeux : elle code des **primitives** (types de réponse, révélations, prise de parole,
scoring, structures, modificateurs) que l'utilisateur assemble. Un format TV ou Twitch = un template.

## Formats de référence → mécaniques

| Format (inspiration) | Mécanique(s) |
|---|---|
| Qui veut gagner des millions ? | `choice` + `ladder` + jokers (50:50, sondage public) |
| Une famille en or | `poll-board` + `buzzer` + 3 erreurs / vol |
| Money Drop | `allocation` |
| Le Maillon faible | `oral` + chaîne / banque + vote d'élimination |
| Questions pour un champion | `buzzer` + `hints` (points dégressifs) |
| Les 12 coups de midi | `choice` / `oral` + `reveal-image` |
| Jeopardy | `board` |
| N'oubliez pas les paroles / Blind test | `text-answer` (fuzzy) + média |
| Motus | `text-answer` mode lettres |
| Le Juste Prix | `number-answer` (closest-without-over) |
| Kahoot | `choice`, `boolean`, `text-answer`, `number-answer`, `order`, `pin`, sondage, rapidité |
| Quiz chat Twitch / YouTube | `crowd-vote` (majorité) ou chaque viewer scoré |

Les règles exactes des émissions sont à revoir sur des épisodes récents avant de figer un template.

## Personas

- **Auteur** : écrit les questions (tableur, import).
- **Concepteur** : assemble un format.
- **Graphiste / DA** : habille (design reçu, gabarit, thème natif).
- **Régie** : pilote le show, corrige en direct.
- **Animateur** : voit les réponses, valide l'oral.
- **Joueur** : tablette, téléphone, buzzer, chat.
