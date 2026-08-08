# Astratra — Mini-app exemple hors école (V0)

## Objectif

Prouver, concrètement, que `@astratra/core` + `@astratra/tooling` +
`@astratra/security` suffisent à démarrer vite une application SaaS différente
de l'application source. C'est l'étape 5 de la stratégie Astratra ("construire une mini-app
exemple hors école") — condition avant de continuer sur `@astratra/ai` ou
`@astratra/saas-kit`.

Ce n'est PAS un package du framework : c'est un exemple consommateur, dans
`examples/clinic-demo/`, qui dépend des packages publiés en `file:` local
(comme fait `packages/security` avec `packages/core`).

## Domaine choisi : petite API de clinique

Rôles : `admin`, `doctor`, `patient` — aucun rapport avec les rôles métier
du projet source, pour bien prouver le découplage.

Fonctionnalités minimales (juste assez pour prouver l'assemblage, pas une vraie
app) :

1. **Auth** : login qui émet un JWT via `jsonwebtoken` (pas besoin de DB réelle,
   un tableau en mémoire de 3 utilisateurs de démo suffit), utilise
   `@astratra/security` → `createAuthMiddleware` pour protéger les routes.
2. **RBAC** : `authorizeRoles('admin')` protège une route
   `GET /admin/patients` (liste tous les patients) ; `authorizeRoles('doctor',
   'admin')` protège `GET /appointments` ; toute personne authentifiée peut
   accéder à `GET /me`.
3. **Rate limiting** : `createApiLimiter` sur toute l'API, `createLoginLimiter`
   sur `/auth/login`, depuis `@astratra/security`.
4. **WAF** : `createWafMiddleware` monté globalement.
5. **Réponses API** : toutes les routes utilisent `apiResponse` de
   `@astratra/core` pour le format de sortie.
6. **Erreurs** : `errorMiddleware`, `notFoundMiddleware`, `requestIdMiddleware`
   de `@astratra/core` montés sur l'app Express.
7. **Config** : un `astratra.config.json` minimal à la racine de l'exemple,
   consommé par `@astratra/tooling` pour au moins une commande (`astratra
   audit:routes` doit tourner dessus et ne rien trouver d'anormal — les routes
   protégées le sont bien).

## Preuve de vitesse à documenter

Un `examples/clinic-demo/README.md` qui liste, en quelques lignes, ce qu'il a
fallu écrire à la main (routes + données de démo) vs ce qui est venu gratuitement
des packages Astratra (auth, RBAC, rate limit, WAF, format de réponse, gestion
d'erreurs). C'est la preuve concrète pour le pitch "on construit une 2e appli
plus vite".

## Tests

Quelques tests d'intégration légers avec `supertest` (ou requêtes HTTP directes
via `http` + serveur éphémère) : login réussi, accès refusé sans token, accès
refusé avec mauvais rôle, rate limit déclenché après N tentatives de login,
WAF bloque une requête avec payload SQLi évident.

## Hors périmètre

Pas de vraie base de données, pas de frontend, pas de vraies notifications —
seulement ce qu'il faut pour prouver l'assemblage des 3 packages existants.
