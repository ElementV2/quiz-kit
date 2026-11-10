---
description: Prend la prochaine case non cochée de la roadmap (ou celle passée en argument) et la mène jusqu'au commit.
---

1. Lis `docs/ROADMAP.md`. Tâche cible : $ARGUMENTS, sinon la première case non cochée de la phase en cours.
2. Lis les docs et ADR concernés (voir `CLAUDE.md`).
3. Écris un plan court : fichiers touchés, tests prévus, risques live. Si une API de lib est incertaine, vérifie-la d'abord dans sa doc officielle.
4. Délègue au bon sous-agent (`engine-dev`, `realtime-dev`, `frontend-dev`) si la tâche est dans son périmètre.
5. Tests d'abord, puis implémentation.
6. `pnpm lint && pnpm typecheck && pnpm test`.
7. Si engine, protocol ou server sont touchés : passe au `reviewer` et corrige ce qu'il remonte.
8. Coche la case, ajoute un ADR si une décision structurante a été prise, commit en Conventional Commits.
9. Résume en 5 lignes max : ce qui est fait, ce qui reste, ce qui est à vérifier.
