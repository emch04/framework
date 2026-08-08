# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Chaque package Astratra est versionné indépendamment.

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
