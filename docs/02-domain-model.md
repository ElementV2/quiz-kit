# 02 — Modèle de données (`packages/schema`)

Tout est JSON validé par Zod. Chaque document racine porte `schemaVersion` ; les migrations
sont des fonctions pures `vN → vN+1` testées sur des fixtures.

## Contenu

- `Question` : `id`, `prompt` ({ text, media? }), `answerSpec`, `hints[]`, `tags[]`, `difficulty`, `notes` (fiche animateur).
- `AnswerSpec` (union discriminée sur `kind`) :
  - `single` / `multi` (`options[]`, `correct: id | id[]`, `minPick`, `maxPick`)
  - `boolean`, `categories` (`categories[]`, mapping option → catégorie)
  - `text` (`accepted[]`, `synonyms[]`, `fuzzy` : seuil, casse/accents ignorés)
  - `number` (`value`, `tolerance`, `mode` : exact | closest | closest-without-over)
  - `order` (`options[]`, ordre correct), `pairs`, `pin` (image + zone correcte)
  - `allocation` (`options[]`, `correct`, `budget`) — Money Drop
  - `poll` (`options[]` avec `value` = %, `synonyms[]`) — Famille en or, sondages
  - `oral` (validation opérateur, `expected` affiché à l'animateur)
- `Option` : `id`, `label`, `media?`, `value?`, `synonyms?`.
- `Media` : `hash` (SHA-256), `mime`, `w`, `h`, `durationMs?`, `in/out?`.
- `QuestionSet` : `questions[]` (ids), `order` : fixed | shuffled(seed).

## Format

- `Format` : `id`, `name`, `participants` ({ mode: solo | teams | crowd, min, max, teamSize? }),
  `rounds[]`, `jokers[]`, `tieBreak`, `defaults`.
- `Round` : `id`, `title`, `mechanic` (id de mécanique enregistrée), `mechanicConfig` (validée par le
  schéma de la mécanique), `source` (set + filtre + nombre), `reserve[]`, `timer`, `scoring`, `endCondition`.
- `ScoringRule` : composition (`base`, `timeDecay`, `hintDecay`, `proportional`, `ladder`, `multiplier`, `penalty`).
- `Joker` : `id`, `effect` (hide-options, poll-audience, extra-time, skip, double), `uses`, `whoCanUse`.

## Scène et habillage

- `Scene` : `id`, `audience` (program | wall | host | control | player), `size` ({ w:1920, h:1080 } ou responsive),
  `layers[]`.
- `Layer` : `z`, `name`, `mode` (auto | manual | auto-hold), `zones[]`, `in`, `out`.
- `Zone` : `id`, `type` (question, answer, answer-list, player-button, input, timer, score, leaderboard,
  ladder, board, media, reveal-image, vote-histogram, joker, text, image), `rect` ({x,y,w,h}),
  `bind` (chemin dans la vue, ex. `answers[2].label`), `repeat?` ({ of, layout, gap }),
  `states` (map état → { style, asset?, anim? }), `interactive?`, `textBox` (marges, auto-fit), `nineSlice?`.
- `ZoneState` (enum de littéraux) : `hidden | masked | revealed | selected | locked | correct | wrong | disabled`.
- `Theme` : tokens (couleurs avec rôles, polices, arrondis), `material`, `motion`
  (snappy | elegant | bouncy | dramatic), `sounds`, `moments`.
- `Moment` : `event` (answer.correct, answer.wrong, suspense, timer.last5, ladder.reached, leader.changed,
  podium, player.eliminated, tiebreak), `timeline[]` (anims, particules, son, plein écran).
- `AssetSlot` : ce que le gabarit demande pour une zone (nom de fichier, taille 1x/2x, 9-slice, états).

## Session et joueurs

- `Session` : `id`, `gameSnapshot` (copie figée Contenu+Format+Scènes+Thème au lancement), `seed`,
  `createdAt`, `status`.
- `Participant` : `id`, `displayName`, `photo?`, `teamId?`, `seat?`, `status`
  (active | eliminated | waiting | substitute | disconnected), `channel` (seat | play | buzzer | twitch | youtube).
- `Team` : `id`, `name`, `color`, `captainId?`.
- `ScoreEntry` : `id`, `participantId | teamId`, `delta`, `questionId?`, `reason`
  (auto | bonus | penalty | manual | regrade), `by`, `at`, `voided?`.
- `Event` (journal) : `seq`, `at` (serveur, monotone + mur), `actor`, `action`, `idempotencyKey?`.
