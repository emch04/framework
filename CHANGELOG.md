# Changelog

Format inspire de [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Chaque package Astratra est versionne independamment, mais tous commencent
sur la meme base V0 `0.1.0`.

## [0.1.0] - 2026-08-08

V0 initiale publique des packages Astratra.

### Ajoute

- `@astratra/core` — format de reponse API, gestion d'erreurs, logs,
  request IDs, validation, chargement d'environnement.
- `@astratra/tooling` — CLI `astratra` : `audit:secrets`, `audit:routes`,
  `audit:i18n`, `test`, `deploy`.
- `@astratra/security` — auth JWT avec revocation de session injectee,
  RBAC, rate limiters configurables, WAF, WebAuthn/passkeys avec store de
  credentials injecte.
- `@astratra/ai` — routeur IA multi-provider generique (quotas, cooldown,
  degradation, etat partage Redis optionnel), registre d'outils, boucle
  minimale d'agent avec appels d'outils.
- `@astratra/saas-kit` — starter `createSaasApp()` assemblant auth, users,
  settings, notifications et resume dashboard depuis des adapters injectes.
- `@astratra/store-mongo` — adapters MongoDB/Mongoose pour les contrats
  `usersStore` et `settingsStore` utilises par `@astratra/saas-kit`.
- `@astratra/saas-kit-ui` — dashboard React reutilisable pour demarrer une
  interface SaaS au-dessus de `@astratra/saas-kit`.
- `create-astratra-app` — generateur CLI pour creer une app Astratra avec une
  commande.
- `examples/clinic-demo` — preuve de concept hors domaine scolaire,
  assemblee entierement depuis les packages Astratra.
- `examples/dashboard-ui` — exemple React + Vite couvrant connexion,
  dashboard, users et settings via `@astratra/saas-kit-ui`.
- CI (`.github/workflows/ci.yml`) executant la suite complete sur Node
  20.x/22.x a chaque push et pull request, plus le build du dashboard UI.
- `LICENSE` MIT a la racine et dans chaque package publiable.

### Limites connues

Voir "Limites connues" dans [README.md](README.md) : le dashboard UI de repo
reste un exemple, MongoDB/Mongoose est le seul adapter de persistance reel, le
store de credentials WebAuthn reste une interface, et la boucle d'agent n'a pas
encore de streaming/vision/validation humaine.
