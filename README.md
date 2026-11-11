# Quizzkit

À dézipper à la racine d'un dossier vide (le futur dépôt), puis `git init`.

```
CLAUDE.md                 règles du projet, lues automatiquement par Claude Code
KICKOFF-PROMPT.md         premier prompt à coller
.claude/agents/           sous-agents : engine-dev, realtime-dev, frontend-dev, reviewer
.claude/commands/         /next-task : prend la case suivante de la roadmap jusqu'au commit
docs/00-vision.md … 11-stack.md   spécification par domaine
docs/CONVENTIONS.md       conventions de code (SOLID appliqué, TS, tests, git)
docs/AUDIT.md             audit de l'archi et décisions qui en découlent
docs/ROADMAP.md           phases 0 → 5, cases à cocher, critères de sortie
docs/OPEN-QUESTIONS.md    décisions produit et points à vérifier en doc officielle
docs/adr/                 décisions d'architecture (0000 = gabarit)
```

Utilisation :
1. Dézipper, ouvrir le dossier dans Claude Code.
2. Coller le contenu de `KICKOFF-PROMPT.md`.
3. Valider le découpage de la phase 0, puis enchaîner avec `/next-task`.

Le doc de référence complet reste « Quiz Builder — Architecture ». Ce kit en est la version découpée
pour l'implémentation : en cas d'écart, mettre à jour le doc concerné dans `docs/` et ajouter un ADR.
