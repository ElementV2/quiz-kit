# CLAUDE.md — Quiz Builder (nom de code : `quiz`)

Outil **interne** pour créer, habiller et faire tourner en live n'importe quel jeu de quiz
(façon QVGDM, Famille en or, buzzer culture G, Jeopardy, blind test, quiz chat Twitch, Kahoot-like),
avec régie, animateur, sorties 1920×1080 pour OBS/vMix et participants sur tablettes.

Lis dans cet ordre avant toute tâche : `docs/AUDIT.md` → `docs/01-architecture.md` → `docs/CONVENTIONS.md`
→ le doc du domaine touché → `docs/ROADMAP.md` (phase en cours).

## Non négociables

1. **Rien ne doit casser en live.** Toute feature qui touche au show passe par : test unitaire du moteur,
   test de reconnexion, et ne doit jamais bloquer la boucle de jeu.
2. **Le serveur est l'unique autorité.** Les clients envoient des intentions, jamais un état.
3. **Le moteur (`packages/engine`) est pur** : pas d'I/O, pas de `Date.now()`, pas de `Math.random()`,
   pas de timers. Le temps et l'aléatoire entrent par les actions et la seed de session.
4. **Journal avant diffusion** : une action est écrite dans SQLite avant que son effet soit diffusé.
5. **Aucune donnée secrète côté client** : une tablette joueur ne reçoit jamais la bonne réponse
   avant la révélation. Les vues par rôle sont calculées serveur (`project()`), et testées.
6. **Tout est éditable à la main en live** (scores, joueurs, questions, chrono) et tout est annulable (undo).
7. **Zéro dépendance internet pendant un show** (sauf chat Twitch/YouTube). Usage interne, LAN / VPN.
8. **Ne jamais inventer une API, une option ou une version de lib.** Vérifier dans la doc officielle
   (ou `node_modules` / types) avant de l'utiliser. Si une info n'est pas vérifiable : le dire et
   l'ajouter à `docs/OPEN-QUESTIONS.md`.

## Monorepo

```
packages/schema     Zod : modèles + versionnage + migrations
packages/engine     réducteur pur, mécaniques, scoring, projections par rôle
packages/protocol   messages WebSocket typés, enveloppes, séquences
packages/renderer   composants SolidJS qui rendent une Scene depuis un état projeté
packages/ui         design system des apps internes (régie, studio)
apps/server         Fastify + WebSocket + SQLite + médias + API contrôle (HTTP/WS/OSC)
apps/studio         éditeur : contenu, formats, scènes, thèmes, gabarits
apps/control        régie live
apps/host           vue animateur
apps/player         tablettes / téléphones (PWA)
apps/output         sorties 1920×1080 (OBS Browser Source, vMix Web Browser, LED)
apps/desktop        (phase 4) lanceur Tauri qui supervise le serveur
```

Règles de dépendance (ADR-0007, vérifiées par `pnpm check:deps` + lint) :
`schema` ← `engine` ; `schema` ← `protocol` ; `engine` + `protocol` ← `server` ;
`schema` ← `renderer` ← apps front ; `protocol` ← apps front (client).
Les actions et les vues par rôle sont des schémas de `schema`. Ni le `renderer` ni les apps front ne
dépendent de `engine` (seule exception : `apps/studio`, pour simuler des états).

## Commandes (garder à jour ici)

Node 26 LTS (version fixée dans `.node-version`, lue par fnm ; `engineStrict` refuse une autre version) exécute
le TypeScript directement (type stripping, ADR-0011) : pas de build pour le code Node.

```
pnpm i
pnpm start          # serveur de show (process autonome)
pnpm dev            # serveur en mode dev (+ apps front dès la phase 1)
pnpm test           # vitest, tous paquets
pnpm test:e2e       # playwright (phase 1)
pnpm load           # k6 : 500 clients simulés (k6 doit être installé)
pnpm chaos          # bot Node : kill serveur + coupure réseau, état final comparé
pnpm lint && pnpm typecheck
pnpm check          # lint + typecheck + check:deps + test (CI locale)
```

## Façon de travailler

- Une tâche = une case de `docs/ROADMAP.md`. Avant de coder : plan court, fichiers touchés, tests prévus.
- **Test d'abord** pour le moteur et le protocole (scénarios d'actions → état attendu).
- Toute décision structurante → un ADR dans `docs/adr/` (gabarit `docs/adr/0000-template.md`).
- Commits : Conventional Commits (`feat(engine): ...`). Petits, une intention par commit.
- Fin de tâche : `pnpm check` au vert, case cochée dans la roadmap.
- Versions : toujours la dernière version stable publiée (vérifier `npm view <pkg> version`), sauf
  incompatibilité vérifiée et notée dans un ADR.
- Sous-agents dispo dans `.claude/agents/` : `engine-dev`, `realtime-dev`, `frontend-dev`, `reviewer`.
  Le `reviewer` relit toute PR qui touche `engine`, `protocol` ou `server`.

## Langue

Code, noms de fichiers, identifiants et commits en anglais. UI et docs en français.
