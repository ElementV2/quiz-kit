# 09 — Joueurs, équipes, scores

Tout est éditable à la main, avant et pendant le show, et tracé dans le journal (donc annulable).

## Joueurs

- Création avant le show (saisie, import CSV : nom, équipe, siège), fiches réutilisables.
- Création à l'arrivée via `/play/<code>` (pseudo) ; la régie renomme, refuse, fusionne.
- Nombre de joueurs borné par `Format.participants` (min / max) ; compteur et alerte en régie.
- Statuts : en jeu, remplaçant, éliminé ; changement manuel libre (la connexion est affichée à part).
- Ajout / retrait en cours de partie sans redémarrer.
- Sièges : assignation participant ↔ tablette par glisser-déposer ; échange de tablette en direct
  (score et historique conservés, l'ancienne tablette est déconnectée).

## Équipes

Création, nom, couleur, capitaine, déplacement de joueurs ; score d'équipe = somme ou propre selon le format.

## Scores = registre

- `ScoreEntry` (qui, delta, question, raison, auteur, heure). Total = somme des lignes non annulées.
- Correction : +/− rapide ou total saisi (génère une ligne `manual`), motif optionnel.
- `score.void` annule une ligne ; tout se recalcule.
- `question.regrade` : on corrige la bonne réponse, le moteur recalcule les points de tous pour cette
  question (aperçu avant validation). **Implémenté** (doc 03, ADR-0013) : aperçu `POST /api/regrade/preview`.
- Barème modifiable en direct, doublement, question bonus.
- Départage : règle du format (rapidité cumulée, barrage, décision régie). **Implémenté** : `tieBreak: speed`
  (temps cumulé des bonnes réponses) ou `control` (même rang ; barrage = une manche `number-answer` `closest`).
- Classement masquable à l'antenne / sur tablettes, toujours visible en régie.

## Corrections en direct

Éditer le texte d'une question affichée, remplacer par une question de réserve, sauter / réordonner /
rejouer, rallonger / couper le chrono, rouvrir les réponses, saisir la réponse d'un joueur à sa place.

## Après le show

Export CSV / PDF (classement, détail par question, réponses, gagnants), replay depuis le journal.

**Implémenté** : `GET /api/results?kind=ranking|detail` (CSV pour Excel : `;`, BOM UTF-8, formules
neutralisées) et `?format=html` (page imprimable → PDF par le navigateur), jeton régie ou scoreur.
Replay : `GET /api/journal` (jeton régie ou studio) + onglet Replay du studio (rejeu par le moteur, rendu de
la sortie à chaque étape).
