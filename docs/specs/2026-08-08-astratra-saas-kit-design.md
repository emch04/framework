# Astratra — Design @astratra/saas-kit (V0)

## Contexte

Dernier package prévu du monorepo Astratra. C'est le point d'entrée pour
démarrer vite un nouveau projet : il assemble `@astratra/core`,
`@astratra/security`, `@astratra/ai`, `@astratra/tooling` en un starter
backend prêt à l'emploi, plutôt que de réinventer l'assemblage à chaque fois
(ce que `examples/clinic-demo` a déjà prouvé possible à la main).

Portée V0 de ce package : **backend uniquement**. Le frontend est livre dans
un package separe, `@astratra/saas-kit-ui`, afin de garder une frontiere nette
entre l'API SaaS et l'interface React.

## Package : @astratra/saas-kit

Dépend de `@astratra/core`, `@astratra/security`, `@astratra/ai`.

Contrairement à `examples/clinic-demo` (qui est un exemple figé, non
générique, avec 3 utilisateurs en dur), `@astratra/saas-kit` est une
**factory réutilisable** : `createSaasApp(options)` qui retourne une app
Express configurée, où toute la donnée (utilisateurs, rôles, notifications,
settings) passe par des adapters injectés — même principe de découplage que
`@astratra/security`.

### 1. Utilisateurs (`usersModule`)

`options.usersStore` — adapter fourni par le consommateur :
- `findByEmail(email)`
- `findById(id)`
- `create(userData)`
- `list({ role, limit, offset })`
- `update(id, patch)`

Routes exposées (préfixe `/users`, protégées par `authorizeRoles` selon
`options.roles.adminRoles`, ex. `['owner', 'admin']`) :
- `GET /users` — liste paginée
- `GET /users/:id`
- `POST /users` — création (rôle admin)
- `PATCH /users/:id`

Pas de store en mémoire par défaut fourni comme "vraie" implémentation — un
store en mémoire minimal est fourni UNIQUEMENT pour permettre de démarrer le
starter sans dépendance DB immédiate (comme `examples/clinic-demo`), mais
explicitement documenté comme non persistant / dev-only.

### 2. Auth (réutilise @astratra/security tel quel)

`POST /auth/login` — vérifie via `options.usersStore.findByEmail` +
`options.verifyPassword(user, password)` (fourni par le consommateur — le
starter ne décide pas de l'algorithme de hash), émet un JWT via
`createAuthMiddleware`/`jsonwebtoken` avec `options.jwtSecret`.
`GET /auth/me` — retourne `req.user` (sans champs sensibles, filtrage via
`options.publicUserFields`, défaut `['id','email','role']`).

WebAuthn : exposé mais optionnel — seulement monté si
`options.webauthnStore` est fourni (sinon les routes `/auth/webauthn/*` ne
sont pas enregistrées).

### 3. Parametres (`settingsModule`)

`options.settingsStore` — adapter `{ get(key), set(key, value), getAll() }`.
Routes `/settings` (GET liste, PATCH clé/valeur), protégées par
`options.roles.adminRoles`. Store en mémoire par défaut (dev-only, comme pour
users).

### 4. Notifications (`notificationsModule`)

`options.notify(userId, { title, message, channel })` — fonction fournie par
le consommateur (email, push, in-app — le starter ne décide pas du canal).
Route `POST /notifications/send` (rôle admin) qui appelle `options.notify`.
Pas de queue, pas de historique persistant en V0 — juste le point d'entrée
générique.

### 5. Tableau de bord / stats (`dashboardModule`)

`GET /dashboard/summary` — retourne un résumé minimal générique :
`{ userCount, roleBreakdown }` calculé depuis `usersStore.list`. Pas de KPI
métier (ça, c'est au consommateur de l'étendre — cohérent avec le principe
Astratra de ne jamais coder de logique métier dans le framework).

### 6. Assemblage

`createSaasApp(options)` monte, dans l'ordre : `requestIdMiddleware` →
`createWafMiddleware` → `createApiLimiter` → routes `/auth` (avec
`createLoginLimiter` dessus) → routes protégées (`/users`, `/settings`,
`/notifications`, `/dashboard`) avec `createAuthMiddleware` → 404 → erreur.
Reprend exactement le pattern déjà validé dans `examples/clinic-demo/src/app.js`.

`options.roles` définit les rôles admin par module (par défaut
`{ adminRoles: ['owner', 'admin'] }`) — aucun rôle produit, aucun rôle fixe
imposé, un projet clinique passerait `{ adminRoles: ['admin'] }` par exemple.

## Tests

Tests d'intégration avec `supertest`/`node --test` (même style que
`clinic-demo`) sur une instance créée avec les stores en mémoire par défaut :
login, CRUD users basique, lecture/écriture settings, envoi de notification
(mock `notify`), dashboard summary, et vérification que toutes les routes
protégées répondent 401/403 correctement selon les rôles.

## Preuve à documenter

`packages/saas-kit/README.md` : montrer qu'un nouveau projet peut avoir une
API SaaS (auth + users + settings + notifications + dashboard) fonctionnelle
en quelques lignes de code (juste fournir les stores + `notify`), sans écrire
de middleware de sécurité ni de format de réponse à la main.

## Hors périmètre V0

- Frontend / tableau de bord visuel.
- Persistance réelle (MongoDB, Postgres...) — stores en mémoire dev-only
  seulement, à remplacer par le consommateur.
- Intégration IA dans le starter (pas de route `/oracle` ou équivalent) —
  `@astratra/ai` reste composable séparément si un projet en a besoin.
- Gestion fine des permissions au-delà de `adminRoles` vs authentifié simple.
