# 07 — Studio (`apps/studio`)

## Trois modes

1. **Contenu** : tableur de questions (une ligne = une question, colonnes selon `answerSpec.kind`),
   coller depuis Excel/Sheets, import CSV, panneau détail (médias, indices, synonymes, sondage), validation live.
2. **Format** : timeline de manches en cartes (mécanique, source, qui répond, révélation, chrono, score,
   fin), blocs de règles et jokers. Mode avancé : graphe de la machine d'états (phase 5).
3. **Scènes** : canvas.

## Canvas

- Taille de la scène (1920×1080 par défaut, vertical, tablette), grille, repères, safe areas EBU R 95
  (action safe 3,5 % = 67×38 px, graphics safe 5 % = 96×54 px par bord en 1080p ; voir `OPEN-QUESTIONS.md`).
- Palette de zones typées ; binding auto à l'évidence, modifiable dans l'inspecteur.
- Inspecteur à onglets d'états + « simuler l'état » (le moteur tourne en local sur un état fictif).
- Alignement, distribution, duplication de zones répétées, verrouillage de calques, undo/redo (commandes).

## Trois façons de créer le visuel

### A. Design reçu → poser les zones dessus
- Import de la maquette en calque de référence (PNG/JPG, SVG, PDF, PSD si lisible, export Figma).
- Tracer les zones par-dessus, dupliquer / aligner les répétées.
- Découpe du fond de zone depuis une maquette plate, marqueurs 9-slice à la souris.
- États manquants dérivés automatiquement (teinte, glow, désaturation), modifiables.
- PSD avec calques nommés selon convention → zones créées automatiquement.
- Pipette police/couleur sur la maquette.

**Implémenté (phase 2)** — outils du canevas : Sélection (Maj + clic = sélection multiple, barre aligner /
répartir), Tracer une zone (glisser sur la référence, type au choix), Pipette (couleur lue sur le calque de
référence → primaire / accent / fond / texte). « Importer un PSD » (ag-psd, chargé à la demande) : l'image
aplatie devient le calque de référence, chaque calque ou groupe nommé **`zone:<type>:<id>`** devient une zone
(bornes = pixels du calque, groupe = union des enfants), les calques texte donnent polices / tailles / couleurs.
Un calque vide (sans pixels) n'a pas de bornes dans un PSD : il est signalé « calque vide ».

### B. Gabarit → le graphiste livre propre
- Export par scène : gabarit 1920×1080 (PNG + SVG) avec zones, noms, coordonnées, tailles, 9-slice,
  safe areas, texte le plus long posé ; fichier calques (PSD via ag-psd si validé, sinon SVG multi-calques) ;
  fiche assets (PDF + CSV : fichier, zone, x, y, w×h 1x, taille 2x, 9-slice, états).
  **Implémenté** : gabarit PSD = gabarit SVG en fond verrouillé + un groupe par couche de scène, un calque par
  zone déjà nommé `zone:<type>:<id>` (réimport direct, testé aller-retour) ; fiche PDF = page A4 imprimée par
  le navigateur (« Enregistrer en PDF »), pas de librairie PDF embarquée.
- Une zone répétée = un fichier par état, pas un par case.
- Réimport par convention de nommage (`<zone>_<state>@2x.png`), rapport des manquants / mauvaises tailles.
- Zone agrandie après livraison : 9-slice OK, sinon asset marqué « à refaire » et fiche régénérée.

### C. Généré dans l'app
Moteur de thèmes (voir `06-scenes-renderer.md`).

## Assets à taille fixe

Fond 1920×1080 (livrer 3840×2160), stinger 1920×1080 ProRes 4444 ou WebM VP9 alpha (transcodé par l'app),
logo SVG (sinon PNG alpha ≥ 1000 px de large), avatar carré ≥ 512×512, sons WAV 48 kHz.
Contrôles à l'import : dimensions, alpha, licence de police déclarée, échantillonnage audio (conversion auto).

## Modifier une partie en direct (« Envoyer au direct »)

Quand la partie ouverte dans le studio est celle lancée en régie, l'en-tête affiche **En direct** et le bouton
**Envoyer au direct**. Le studio charge alors le document du direct (`GET /api/live/game`, corrections de la régie
comprises) et retient sa version (`gameVersion`). L'envoi (`POST /api/games/:id/apply-live`, `{ game, baseVersion }`)
passe par l'action journalisée `game.patch` ; la régie, les sorties, l'animateur et les tablettes se mettent à jour
sans relancer. La régie affiche le badge « modifiée HH:MM ».

Autorisé : nouvelles manches et questions, questions pas encore jouées, habillage (thème, scènes), titre, limites
de joueurs compatibles avec les joueurs présents.

Refusé (message en clair dans le studio) :
- supprimer une question jouée ou changer sa réponse (→ « Corriger la réponse » en régie) ;
- déplacer une manche commencée, changer son type ou son barème ;
- changer les réglages de la manche en cours après sa première question ;
- déplacer les questions déjà présentées ; un plateau (Jeopardy) en cours garde sa grille telle quelle ;
- sur la question à l'antenne, autre chose que son texte ;
- un envoi fait sur une version périmée (correction en régie entre-temps) : le studio propose de recharger la
  version du direct. Sans changement en attente, le studio suit le direct tout seul.

`game.patch` ne s'annule pas (`NEVER_UNDONE`) : pour revenir en arrière, renvoyer la version précédente. Une mise
d'enjeu (×N) posée sur une place où une autre question arrive est retirée. Chaque envoi écrit le document complet
dans le journal (quelques dizaines de Ko) : rester raisonnable sur le nombre d'envois pendant un show.

## Templates

Format + Scènes + Thème + set d'exemple : QCM à paliers, sondage à slots, buzzer culture G, blind test,
Jeopardy, quiz chat Twitch, Kahoot-like 50 joueurs. On reprend les mécaniques, jamais les habillages ou logos des émissions.

## Mode Répétition

Session simulée avec bots joueurs (nombre, taux de bonnes réponses, latence) pour tester un format et ses scènes.

**Implémenté** (serveur, `apps/server/src/rehearsal.ts`) : `POST /api/rehearsal { bots, accuracy, latencyMs }`
(jeton régie) ajoute `Bot 1…n` (`p_bot_<n>`) qui répondent par le pipeline normal (journal, acks, vues) à
chaque ouverture, avec la justesse et la latence demandées ; `DELETE /api/rehearsal` les retire (avec leurs
points). Les bots buzzent (buzzer, plateau) mais le jugement reste humain ; rien sur le sondage à slots.
Jamais pendant un vrai show : les bots sont des joueurs du journal.
