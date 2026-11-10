# 09 — Joueurs, équipes, scores

Tout est éditable à la main, avant et pendant le show, et tracé dans le journal (donc annulable).

## Joueurs

- Création avant le show (saisie, import CSV : nom, pseudo, photo, équipe, siège), fiches réutilisables.
- Création à l'arrivée via `/play/<code>` (pseudo) ; la régie renomme, refuse, fusionne.
- Nombre de joueurs borné par `Format.participants` (min / max) ; compteur et alerte en régie.
- Statuts : active, eliminated, waiting, substitute, disconnected ; changement manuel libre.
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
  question (aperçu avant validation).
- Barème modifiable en direct, doublement, question bonus.
- Départage : règle du format (rapidité cumulée, barrage, décision régie).
- Classement masquable à l'antenne / sur tablettes, toujours visible en régie.

## Corrections en direct

Éditer le texte d'une question affichée, remplacer par une question de réserve, sauter / réordonner /
rejouer, rallonger / couper le chrono, rouvrir les réponses, saisir la réponse d'un joueur à sa place.

## Après le show

Export CSV / PDF (classement, détail par question, réponses, gagnants), replay depuis le journal.
