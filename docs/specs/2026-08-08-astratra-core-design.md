# Astratra — Design initial (V0)

## Contexte

Astratra est un framework SaaS modulaire extrait de l'expérience acquise sur
une plateforme métier existante. Astratra n'est pas cette application source :
aucune logique métier spécifique (entités, rôles fixes, workflows produit)
ne doit y être portée. L'objectif est d'extraire uniquement les briques
génériques réutilisables pour démarrer rapidement d'autres SaaS sécurisés avec IA
(clinique, e-commerce, restaurant, entreprise, dashboard SaaS...).

Premier objectif (avant toute idée de vente) : prouver qu'on peut construire une
deuxième application métier beaucoup plus vite grâce à Astratra.

## Architecture globale

Monorepo unique, géré avec npm workspaces :

```
astratra/
├── packages/
│   ├── core/        base commune : apiResponse, logger, errorMiddleware,
│   │                 asyncHandler, AppError, config env
│   ├── security/      JWT, WebAuthn/passkeys, RBAC configurable par projet,
│   │                 rate limit, WAF, scan de secrets, audit de routes
│   ├── ai/           routing multi-modèles, fallback providers, quotas,
│   │                 registre d'outils generique, garde-fous
│   ├── tooling/       CLI : test, deploy, docker, i18n, security scan, route audit
│   └── saas-kit/      starter : auth + dashboard + settings + users + roles + notifications
└── docs/
```

Dépendances : `security`, `ai`, `tooling` dépendent de `core`. `saas-kit` dépend de tout
le reste et sert de point de départ pour un vrai projet.

Ordre de construction : `core` → `tooling` → `security` → `ai` → `saas-kit`.

## Package 1 — @astratra/core (portée de ce spec)

Contenu, extrait/généralisé depuis l'application source (`shared/utils/apiResponse.js`,
`backend/src/middlewares/{error,notFound,requestId,validate}.middleware.js`,
`shared/utils/logger.js`) :

- `apiResponse(res, statusCode, message, data, success)` — format JSON unifié
  `{success, message, data, timestamp}`, alias `error` quand `success=false`.
- `asyncHandler(fn)` — wrapper pour éviter les try/catch répétés dans les routes Express.
- `createLogger(serviceName)` — factory de logger, no-op en `NODE_ENV=test`.
- `AppError` — classe d'erreur de base avec `statusCode`.
- `errorMiddleware` — capture centralisée des erreurs Express, réponse JSON standardisée,
  stack trace uniquement en dev.
- `notFoundMiddleware` — 404 JSON générique.
- `requestIdMiddleware` — attache un UUID à chaque requête (header `X-Request-Id`).
- `validateMiddleware` — intègre `express-validator`, retourne 400 + erreurs si invalide.
- `loadEnv(schema)` — chargeur de config par variables d'environnement, générique
  (pas de clés produit en dur).

Contraintes :
- Aucune dépendance à MongoDB/Mongoose, aucune dépendance à un modèle `Config` métier.
- Express en `peerDependency` optionnelle (le package doit rester utilisable sans Express
  pour les parties non-HTTP comme le logger).
- Zéro référence à des rôles, écoles, élèves ou toute notion métier.

## Hors périmètre de ce spec

`security`, `ai`, `tooling`, `saas-kit` — packages suivants, chacun avec son propre
spec + plan une fois `core` validé.

## Tests

Chaque module de `core` doit avoir une couverture de tests unitaires (Jest), sans
dépendance à une base de données ou un serveur réel.
