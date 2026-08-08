# Astratra

Astratra est un framework SaaS modulaire extrait de patterns éprouvés sur
une plateforme métier existante, sans aucune logique métier propre à cette
application source. Il existe pour répondre à une seule question : **est-ce
qu'un autre type de SaaS (clinique, e-commerce, outil interne, tout ce qui a
des utilisateurs/rôles/sécurité/IA) peut être construit sensiblement plus
vite en réutilisant une infrastructure déjà éprouvée en production ?**

`examples/clinic-demo/` en est la preuve concrète : une petite API de
clinique, sans rapport avec les écoles, assemblée entièrement à partir des
packages Astratra, sans auth, rate limiting, WAF ou format de réponse
réimplémentés.

## Statut

Astratra V0 est compose de 8 packages npm publics. Les dépendances internes
utilisent des versions semver (`^0.1.0`), chaque package publiable déclare
`publishConfig.access: "public"`, les tarballs sont limités aux fichiers utiles
(`src`/`bin` selon le package), et la CI (`.github/workflows/ci.yml`) fait
tourner lint, typecheck, tests et build du dashboard React sur Node 20.x/22.x.

`@astratra/store-mongo` apporte un adapter de persistance réel,
`@astratra/saas-kit-ui` apporte l'interface React réutilisable, et
`create-astratra-app` sert de générateur pour créer une app Astratra avec une
commande. `examples/dashboard-ui` reste volontairement un exemple de repo qui
consomme `@astratra/saas-kit-ui`.

| Package | Tests | Rôle |
|---|---|---|
| [`@astratra/core`](packages/core/README.md) | 20 | réponses API, gestion d'erreurs, logs, request id, config env |
| [`@astratra/tooling`](packages/tooling/README.md) | 20 | CLI : audit secrets/routes/i18n, lanceur de tests, orchestrateur de déploiement |
| [`@astratra/security`](packages/security/README.md) | 24 | auth JWT, RBAC, rate limiting (mémoire ou Redis optionnel), WAF, WebAuthn/passkeys |
| [`@astratra/ai`](packages/ai/README.md) | 12 | routing IA multi-provider avec quotas/fallback/Redis optionnel, registre d'outils, boucle d'agent |
| [`@astratra/saas-kit`](packages/saas-kit/README.md) | 8 | starter : `createSaasApp()` assemblant users/auth/settings/notifications/dashboard |
| [`@astratra/store-mongo`](packages/store-mongo/README.md) | 6 | adapter de persistance réel (MongoDB/Mongoose) pour `usersStore`/`settingsStore` |
| [`@astratra/saas-kit-ui`](packages/saas-kit-ui/README.md) | 2 | dashboard React réutilisable pour `@astratra/saas-kit` |
| [`create-astratra-app`](packages/create-astratra-app/README.md) | 3 | générateur CLI pour créer une app Astratra rapidement |
| [`examples/clinic-demo`](examples/clinic-demo/README.md) | 5 | preuve de concept API hors du domaine scolaire |
| [`examples/dashboard-ui`](examples/dashboard-ui/README.md) | 2 | exemple React + Vite consommant `@astratra/saas-kit-ui` et l'API `saas-kit` |

**102 tests au total**, plus `npm run lint`, `npm run typecheck` et le build
du dashboard React. Chaque package a été vérifié indépendamment —
dépendances réellement installées et tests réellement exécutés (pas juste
rapportés), plus relecture manuelle du code et passe de grep confirmant
qu'aucune référence spécifique à l'application source (domaine, rôles fixes,
IDs de modèles, noms de collection base de données) n'a fui dans un package.

## Principe de conception

Astratra ne contient jamais de logique métier. Partout où l'application
source codait en dur un appel base de données, un nom de rôle ou une décision
produit, le code Astratra équivalent le prend en adapter/callback injecté :

- `createAuthMiddleware` de `@astratra/security` prend un callback optionnel
  `verifySession(decoded)` au lieu d'interroger une collection Mongoose
  codée en dur pour la révocation de session.
- `createProviderRouter` de `@astratra/ai` prend un tableau `providers` que
  vous définissez — aucun catalogue Groq/Gemini/Mistral intégré.
- `createSaasApp` de `@astratra/saas-kit` prend `usersStore`,
  `settingsStore`, `notify` et `verifyPassword` — aucune base de données,
  algorithme de hash ou canal de notification fixé.

Les rôles sont toujours de simples strings fournis par le projet
consommateur — un projet scolaire utilise
`director`/`teacher`/`parent`/`student`, une clinique utilise
`admin`/`doctor`/`patient`, rien dans Astratra ne présuppose l'un ou
l'autre.

## Démarrage rapide

Créer une application complète :

```bash
npm create astratra-app@latest my-app
cd my-app
npm install
npm run dev:api
npm run dev:web
```

Créer une API seule :

```bash
npm create astratra-app@latest my-api -- --template api
cd my-api
npm install
npm run dev:api
```

Installer les packages à la main dans un projet existant :

```bash
npm install @astratra/core @astratra/security @astratra/ai @astratra/saas-kit
npm install @astratra/store-mongo mongoose
npm install @astratra/saas-kit-ui react react-dom
```

## Développement du monorepo

```bash
npm install
npm test --workspaces
```

Essayer la preuve de concept :

```bash
npm test --workspace=clinic-demo
npm run audit:routes --workspace=clinic-demo
```

Tester l'exemple dashboard :

```bash
npm run dev:backend --workspace @astratra/dashboard-ui-example
npm run dev --workspace @astratra/dashboard-ui-example
```

## Exemple e-commerce

```bash
npm create astratra-app@latest astratra-shop
cd astratra-shop
npm install
npm run dev:api
npm run dev:web
```

Tu obtiens une base SaaS generique avec auth, roles, settings, dashboard et
notifications. Il reste ensuite a ajouter les modules metier e-commerce :
catalogue, panier, commandes, paiements et gestion des produits.

## Installation manuelle minimale

Backend :

```bash
npm install @astratra/saas-kit @astratra/security @astratra/core
```

Persistance MongoDB :

```bash
npm install @astratra/store-mongo mongoose
```

Dashboard React :

```bash
npm install @astratra/saas-kit-ui react react-dom
```

## Commandes utiles

```bash
npm create astratra-app@latest my-app
cd my-app
npm install
npm run dev:api
npm run dev:web
```

## Structure du repo

```
astratra/
├── .github/workflows/ci.yml   — tests sur Node 20.x/22.x à chaque push/PR
├── packages/
│   ├── core/
│   ├── tooling/
│   ├── security/
│   ├── ai/
│   ├── saas-kit/
│   ├── store-mongo/
│   ├── saas-kit-ui/
│   └── create-astratra-app/
├── examples/
│   ├── clinic-demo/
│   └── dashboard-ui/
├── docs/specs/   — un design doc par package, écrit avant l'implémentation
└── LICENSE                    — MIT
```

Chaque package a été construit à partir d'un spec écrit (dans
`docs/specs/`) avant toute génération de code, et chaque
implémentation a été vérifiée indépendamment (install des dépendances avec
accès réseau réel, tests réellement exécutés, code relu, grep anti-fuite
métier) plutôt que prise pour argent comptant d'un rapport de génération.

## Publication mainteneur

Ordre recommandé pour publier une nouvelle version :

```bash
npm publish --workspace @astratra/core --access public
npm publish --workspace @astratra/tooling --access public
npm publish --workspace @astratra/security --access public
npm publish --workspace @astratra/ai --access public
npm publish --workspace @astratra/store-mongo --access public
npm publish --workspace @astratra/saas-kit --access public
npm publish --workspace @astratra/saas-kit-ui --access public
npm publish --workspace create-astratra-app --access public
```

`examples/clinic-demo` et `examples/dashboard-ui` sont des exemples de repo et
ne sont pas des packages npm.

## Limites connues (V0)

- **Le dashboard (`examples/dashboard-ui`) reste un exemple de repo.** Le package
  publié est `@astratra/saas-kit-ui`; l'exemple ne sert qu'à tester et montrer
  son intégration avec un backend de développement.
- **`@astratra/store-mongo` est le seul adapter de persistance réel** —
  MongoDB/Mongoose uniquement pour l'instant, pas de Postgres/SQL. Le store
  de credentials WebAuthn reste une interface sans implémentation fournie.
- **La boucle d'agent d'`@astratra/ai` n'a ni streaming, ni gestion
  d'images, ni confirmation humaine** avant d'exécuter un outil — ces options
  restent hors périmètre pour une première version (voir
  `packages/ai/README.md`).

## Contribuer / étendre

Ajouter un nouveau package en écrivant d'abord son spec de design
(`docs/specs/AAAA-MM-JJ-astratra-<nom>-design.md`), en suivant
la même forme que les specs existants : ce qui est extrait, ce qui est
explicitement exclu, et comment ça reste découplé de la logique métier d'un
produit précis.
