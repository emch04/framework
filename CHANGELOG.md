# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Chaque package Astratra est versionné indépendamment.

## 2026-08-15

### Ajoute

- `@astratra/security` (`1.3.0`→`1.4.0`) :
  - `hashPassword(password)` / `verifyPasswordHash(password, hash)` —
    scrypt (natif à Node, aucune dépendance bcrypt/argon2 ajoutée), sel
    aléatoire par hash, comparaison à temps constant. `verifyPassword`
    reste un callback fourni par l'app ; avant, aucune primitive de hachage
    n'existait, rien n'empêchait un `===` en clair.
  - `createSecurityHeadersMiddleware()` — `X-Frame-Options`,
    `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, et
    `Strict-Transport-Security` (actif automatiquement seulement en
    production). Seul CSP était couvert avant ; ce set standard manquait
    entièrement.
  - `createSecurityAuditLogger()` — journalise une ligne structurée pour
    toute requête qui se termine en `401`/`403`/`429` (configurable),
    peu importe quelle couche (CSRF, WAF, rate limit, JWT) l'a produite.
    Avant, aucune de ces couches ne journalisait quoi que ce soit : une
    tentative d'attaque restait invisible tant qu'elle n'avait pas réussi.
- `@astratra/saas-kit` (`1.3.0`→`1.4.0`) — `createSaasApp()` monte
  désormais `createSecurityHeadersMiddleware` et `createSecurityAuditLogger`
  sans condition (comme CSP), au même titre que les couches déjà actives
  par défaut. `options.securityHeaders` personnalise les en-têtes ;
  `options.securityAudit: false` désactive le journal, un objet ou `true`
  le personnalise (sink de log personnalisé, codes de statut surveillés).
  Plancher `@astratra/security` relevé à `^1.4.0` en conséquence.

## 2026-08-14

### Corrige

- `@astratra/saas-kit` (`1.1.1`→`1.2.0`) — **les routes ajoutées après
  `createSaasApp()` étaient silencieusement inatteignables.**
  `createSaasApp()` termine sa propre pile de middlewares par un
  `notFoundMiddleware`/`errorMiddleware` avant de retourner l'app ; toute
  route enregistrée ensuite par l'appelant (`app.get(...)` sur l'objet
  retourné) tombait donc systématiquement sur ce 404 interne. Ajoute
  `options.extendRoutes(app, { authMiddleware, csrfMiddleware,
  authorizeAdmin, authorizeRoles })`, exécuté avant le 404 — c'est
  désormais la façon documentée d'ajouter ses propres routes. L'app
  retournée expose aussi directement `app.authMiddleware`,
  `app.csrfMiddleware` et `app.authorizeAdmin` pour éviter d'en reconstruire
  des doublons divergents.
- `@astratra/saas-kit` / `@astratra/security` (`1.1.1`→`1.2.0`) — **le
  cookie CSRF n'était jamais amorcé par `GET /auth/me`**, le point d'entrée
  naturel d'une session (utilisé par `getSession` de `@astratra/react`).
  Seuls `/auth/logout` et `/auth/logout-all` montaient `csrfMiddleware`
  parmi les routes `/auth`. Une route métier qui ne monte
  `csrfMiddleware` que sur ses handlers mutants (le réflexe naturel)
  finissait par émettre le cookie CSRF dans la même réponse que la requête
  censée le valider — un 403 `Invalid CSRF token` permanent, puisque le
  client n'avait jamais pu lire le cookie à temps. `@astratra/security`
  ajoute `createCsrfCookiePrimer()` : amorce le cookie sur toute requête
  sûre (GET/HEAD/OPTIONS) sans jamais valider de token. `createSaasApp()`
  le monte désormais globalement, avant toutes les routes — y compris
  celles ajoutées via `extendRoutes`. `createCsrfMiddleware()` et le primer
  vérifient aussi les cookies déjà mis en file sur la même réponse avant
  d'en émettre un nouveau, pour rester idempotents quand les deux
  s'exécutent sur une même requête.
- `create-astratra-app` (`1.0.2`→`1.1.0`) — le template généré n'illustrait
  nulle part comment ajouter une route métier, alors que c'est le tout
  premier geste de quiconque démarre un projet avec le starter.
  `api/server.js` montre maintenant `extendRoutes` avec un exemple concret
  (`GET /api/status`, branché sur l'outil `health_check` d'`api/ai/tools.js`
  — jusque-là scaffoldé mais jamais câblé). `@astratra/store-mongo` et
  `mongoose` passent de `dependencies` à `optionalDependencies` dans le
  `package.json` généré : ils sont scaffoldés (`api/stores/mongo.js`,
  `api/db/mongo.js`) mais pas utilisés par défaut (le projet démarre sur le
  store mémoire), donc plus besoin d'installer un driver Mongo avant d'avoir
  choisi de s'en servir.

### Ajoute

- `@astratra/security` (`1.2.0`→`1.3.0`) — `createCorsMiddleware(options)`.
  Astratra n'a jamais imposé de politique CORS fixe (les origines
  autorisées sont spécifiques à chaque projet) mais ne fournissait aucune
  primitive non plus, poussant chaque consommateur — y compris le template
  `create-astratra-app` lui-même — à réimplémenter sa propre version. C'est
  cette même logique, déjà éprouvée, qui est promue en primitive partagée.
  Origines `127.0.0.1`/`localhost` autorisées par défaut hors production,
  `credentials` activé par défaut (sessions cookie), `OPTIONS` court-circuité
  en 204.
- `@astratra/saas-kit` (`1.2.0`→`1.3.0`) — `options.cors`, monté tout premier
  dans la pile de `createSaasApp()`, avant absolument tout le reste — y
  compris les routes ajoutées via `extendRoutes`. Élimine le piège classique
  où un `app.use(cors())` ajouté après coup sur l'app retournée ne s'applique
  jamais aux routes déjà montées en interne (`/auth`, etc.). Omis, rien ne
  change.
- `create-astratra-app` (`1.1.0`→`1.2.0`) — le template généré utilise
  désormais `createSaasApp({ cors: {...} })` au lieu d'envelopper l'app dans
  un `express()` externe avec un middleware CORS maison
  (`api/config/cors.js`, supprimé). Planchers `@astratra/saas-kit` et
  `@astratra/security` relevés à `^1.3.0` en conséquence ; `express` retiré
  des dépendances directes du projet généré (n'y était plus utilisé
  directement, disponible en transitif via `saas-kit`).
- `@astratra/security` (`1.3.0`→`1.4.0`) — `createMemoryWebauthnStore()`,
  implémentation de référence en mémoire du contrat `WebauthnStore`, même
  motif que `createMemoryUsersStore`/`createMemorySettingsStore` : avant,
  aucun store WebAuthn par défaut n'existait, il fallait en écrire un avant
  de pouvoir simplement essayer le flux. Credentials perdues au redémarrage
  — à remplacer par une vraie base avant la prod. Ajoute aussi
  `createFieldCipher(options)` / `generateFieldEncryptionKey()` : chiffrement
  de champ AES-256-GCM authentifié pour les valeurs qu'une app écrit
  elle-même dans son store — Astratra ne s'intercale jamais entre l'app et
  sa base, donc rien en amont ne pouvait chiffrer les données à sa place.
- `@astratra/ai` (`1.0.2`→`1.1.0`) — `runAgentLoop` accepte deux nouveaux
  callbacks optionnels, tous deux sans effet si omis. `onChunk(chunk)` :
  appelé pour chaque morceau reçu quand `router.ask()` retourne un flux —
  avant, `stringifyModelResponse` consommait le flux en entier avant de
  rendre la main, aucun streaming token par token n'atteignait l'appelant
  même si le provider le supportait. `confirmTool(toolCall, ctx)` : attendu
  avant l'exécution d'un appel d'outil détecté ; retourner `false` annule
  l'exécution sans faire planter la boucle (le modèle reçoit
  `{"denied": true}` comme résultat et peut réagir) — avant, chaque appel
  d'outil autorisé par le rôle s'exécutait automatiquement, sans point
  d'arrêt possible pour une confirmation humaine.
- `@astratra/store-mongo` (`1.0.2`→`1.1.0`) et `@astratra/store-postgres`
  (`1.0.2`→`1.1.0`) — `createMongoMigrationRunner`/
  `createPostgresMigrationRunner` : un runner minimal, pas un DSL ni une
  CLI — étant donné un tableau `{ id, up(client) }`, applique une seule fois
  chaque migration non encore vue, dans l'ordre, suivi par `id` dans une
  table/collection dédiée. La variante Postgres enveloppe chaque migration
  dans sa propre transaction (annulée en cas d'échec) ; la variante Mongo
  ne le fait pas (pas de transactions inter-collections sur un déploiement
  standalone) — voir les README respectifs. Avant, aucun outil de ce type
  n'existait dans le framework : faire évoluer un schéma en prod restait
  entièrement manuel.

## 2026-08-09

### Modifie

- Tous les packages publics (`@astratra/ai` `1.0.1`→`1.0.2`, `@astratra/core`
  `1.0.0`→`1.0.1`, `create-astratra-app` `1.0.1`→`1.0.2`,
  `@astratra/prerender` `0.1.0`→`0.1.1`, `@astratra/react` `0.1.0`→`0.1.1`,
  `@astratra/saas-kit` `1.1.0`→`1.1.1`, `@astratra/saas-kit-ui`
  `1.0.0`→`1.0.1`, `@astratra/security` `1.1.0`→`1.1.1`,
  `@astratra/store-mongo`/`store-postgres` `1.0.1`→`1.0.2`,
  `@astratra/tooling` `1.0.0`→`1.0.1`) déclarent maintenant `engines.node
  ">=20"`, aligné sur la matrice CI. Sans ça, un `npm install` sous Node < 20
  ne loguait un problème qu'à l'exécution, pas à l'installation.
- `@astratra/saas-kit-ui` et `@astratra/react` documentent maintenant
  explicitement leur différence : `saas-kit-ui` reste dashboard complet +
  JWT en mémoire (`Authorization: Bearer`), `@astratra/react` reste
  primitives nues + session cookie `HttpOnly`, sans dashboard imposé — ce
  n'était pas documenté et pouvait passer pour un doublon accidentel entre
  les deux packages.

### Ajoute

- `@astratra/prerender` (`0.1.0`) — première version. Prérendu SEO générique
  pour un site Vite + React : `prerender()` et le binaire `astratra-prerender`
  génèrent un `index.html` par route (Playwright + `vite preview`), préservent
  `dist/_shell.html` vierge pour les visiteurs humains, et exposent
  `transformHtml(html, context)` / `isReady(page, route)` pour l'adaptation par
  projet. `audit.js` vérifie titre et description présents, détecte les titres
  et le contenu visible dupliqués entre pages, et avertit sans bloquer sur un
  contenu trop mince. Couvert par un test d'intégration bout-en-bout (vrai
  Vite, vrai Chromium, 14 cas), en plus des tests unitaires des fonctions pures.
- `@astratra/security` (`1.0.2` → `1.1.0`) — sessions cookie `HttpOnly`
  intégrées : `setSessionCookie`/`clearSessionCookie` (`HttpOnly` toujours,
  `Secure` par défaut sauf `NODE_ENV=development`, `SameSite` configurable),
  `cookieParserMiddleware()` pour peupler `req.cookies` sans dépendance
  `cookie-parser`, et `createCsrfMiddleware()` (double-submit cookie/header,
  bypass automatique pour les clients authentifiés par `Authorization:
  Bearer`). Révocation JWT ajoutée : `createMemoryRevocationStore()` avec
  `revoke`/`isRevoked` (par `jti`, un token précis) et
  `revokeAllForUser`/`isRevokedForUser` (par utilisateur et `iat`, pour un
  logout de tous les appareils). `createAuthMiddleware({ revocationStore })`
  dérive automatiquement `verifySession` si aucun n'est fourni explicitement.
  Tous les nouveaux exports typés dans `index.d.ts` et exercés dans
  `typecheck.ts`.
- `@astratra/saas-kit` (`1.0.2` → `1.1.0`) — `createSaasApp` monte désormais
  `cookieParserMiddleware()` et un `revocationStore` mémoire par défaut,
  branche le CSRF sur toutes les routes mutantes protégées, et ajoute
  `POST /auth/logout` (invalide le token courant) et `POST /auth/logout-all`
  (invalide tous les tokens actifs de l'utilisateur). Dépendance sur
  `@astratra/security` resserrée à `^1.1.0`.
- `@astratra/react` (`0.1.0`) — première version. Primitives React
  optionnelles (`SessionProvider`, `useSession`, `useUser`,
  `usePermissions`, `RequireAuth`, `RequireRole`, `createApiFetch`) pour
  consommer une session cookie `HttpOnly` côté client sans imposer
  d'endpoint, de routing ni de configuration CSRF — ça reste la
  responsabilité de l'application consommatrice. Testé avec
  `@testing-library/react` sur un DOM `jsdom` monté pour `node --test`.

### Corrige

- `@astratra/saas-kit` (`1.0.2` → `1.1.0`) — le cookie de session posé au
  login n'était jamais relu par le middleware d'authentification :
  `createSaasApp` ne montait aucun cookie-parser (`req.cookies` restait
  `undefined`) et le nom de cookie par défaut attendu par `jwtAuth.js`
  (`token`) ne correspondait pas au nom réellement posé
  (`astratra_session`). Un client web se connectant et rappelant une route
  protégée avec uniquement ce cookie recevait `401` au lieu de `200`.
  Confirmé par test de mutation avant correctif (rejeu du cookie posé au
  login contre une route protégée), pas trouvé par simple lecture de code.
- `@astratra/saas-kit` (`1.1.0`) — `POST /auth/logout-all` plantait en `500`
  si un `revocationStore` personnalisé n'implémentait pas la méthode
  optionnelle `revokeAllForUser` (marquée `?` dans l'interface
  `RevocationStore`). Dégrade maintenant proprement (`200`, logout-all
  no-op) quand la méthode est absente. Trouvé par mutation avec un store
  minimal ne fournissant que `revoke`/`isRevoked`.
- `@astratra/security` (`1.0.1` → `1.0.2`) — `createWafMiddleware()` avertit
  désormais (une seule fois par instance, via le logger de `@astratra/core`)
  quand `req.body` vaut `undefined` au moment de son exécution. Monté avant
  `express.json()`, ce middleware inspectait silencieusement une chaîne vide
  à la place du corps réel de la requête : un payload SQLi/XSS dans le body
  passait sans être bloqué, sans la moindre erreur pour le signaler. Trouvé
  en testant manuellement une injection réelle sur une app consommatrice, pas
  par les tests existants — aucun n'exerçait ce cas. README mis à jour avec
  l'ordre de montage requis.
- `@astratra/security` (`1.0.1` → `1.0.2`) — même défaut trouvé et corrigé
  dans `createAccountLimiter()` : sa clé de compte par défaut lit aussi
  `req.body.email`. Monté avant `express.json()`, toutes les tentatives de
  connexion retombaient sur la clé partagée `"unknown"` — plus de limite par
  compte, une seule limite globale partagée par tous les comptes (bypass
  partiel de la protection anti brute-force, et risque de blocage
  d'utilisateurs sans rapport entre eux). Même avertissement une seule fois,
  README mis à jour. Trouvé en auditant systématiquement les autres
  middlewares du package après le premier correctif, pas par hasard.
- `@astratra/saas-kit` — sa dépendance sur `@astratra/security` resserrée de
  `^1.0.1` à `^1.0.2`, pour qu'une installation fraîche ne puisse plus jamais
  résoudre la version vulnérable (`^1.0.1` la couvrait déjà implicitement,
  mais sans l'exiger explicitement). Aucun changement de code dans
  `saas-kit` lui-même — il montait déjà `express.json()` avant le WAF
  correctement.

## [1.0.0] - 2026-08-08

Première version à API publique stable pour les fondations SaaS Astratra.
Cette v1 stabilise les contrats des packages publiables et ajoute
`@astratra/store-postgres` comme second adapter de persistance réel.

Cette version ne promet pas une application finale complète ni une sécurité
garantie : elle fournit une base technique réutilisable, testée et extensible.

### Ajoute

- `@astratra/store-postgres` — adapters PostgreSQL/`pg` pour les contrats
  `usersStore` et `settingsStore`, même contrat que `@astratra/store-mongo`,
  moteur différent. Tests via `pg-mem`, aucune instance Postgres externe
  requise.
- `@astratra/security` — CSP configurable (`createCspMiddleware`), montée
  par défaut dans `createSaasApp` avec une politique `default-src 'none'`
  adaptée à une API JSON.
- `@astratra/saas-kit` — validation d'entrée réelle (`express-validator` +
  `validateMiddleware`) sur `/auth/login`, `POST /users`,
  `PATCH /settings/:key` et `POST /notifications/send`.

### Modifie

- Toutes les versions de packages passent de `0.1.x` à `1.0.0`, y compris
  les plages de dépendances internes (`^0.1.0` -> `^1.0.0`).
- `create-astratra-app` génère désormais des projets qui dépendent des
  packages Astratra en `^1.0.0`.

## [0.1.0] - 2026-08-08

V0 initiale publique des packages Astratra.

### Ajoute

- `@astratra/core` — format de réponse API, gestion d'erreurs, logs,
  request IDs, validation, chargement d'environnement.
- `@astratra/tooling` — CLI `astratra` : `audit:secrets`, `audit:routes`,
  `audit:i18n`, `test`, `deploy`.
- `@astratra/security` — auth JWT avec révocation de session injectée,
  RBAC, rate limiters configurables, WAF, WebAuthn/passkeys avec store de
  credentials injecté.
- `@astratra/ai` — routeur IA multi-provider générique (quotas, cooldown,
  dégradation, état partagé Redis optionnel), registre d'outils, boucle
  minimale d'agent avec appels d'outils.
- `@astratra/saas-kit` — starter `createSaasApp()` assemblant auth, users,
  settings, notifications et résumé dashboard depuis des adapters injectés.
- `@astratra/store-mongo` — adapters MongoDB/Mongoose pour les contrats
  `usersStore` et `settingsStore` utilisés par `@astratra/saas-kit`.
- `@astratra/saas-kit-ui` — dashboard React réutilisable pour démarrer une
  interface SaaS au-dessus de `@astratra/saas-kit`.
- `create-astratra-app` — générateur CLI pour créer une app Astratra avec une
  commande.
- `examples/dashboard-ui` — exemple React + Vite couvrant connexion,
  dashboard, users et settings via `@astratra/saas-kit-ui`.
- CI (`.github/workflows/ci.yml`) exécutant la suite complète sur Node
  20.x/22.x à chaque push et pull request, plus le build du dashboard UI.
- `LICENSE` MIT à la racine et dans chaque package publiable.

### Limites connues

Voir "Limites connues" dans [README.md](README.md) : le dashboard UI de repo
reste un exemple, MongoDB/Mongoose est le seul adapter de persistance réel, le
store de credentials WebAuthn reste une interface, et la boucle d'agent n'a pas
encore de streaming/vision/validation humaine.
