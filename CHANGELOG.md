# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Chaque package Astratra est versionné indépendamment.

## 2026-08-09

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

### Corrige

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
