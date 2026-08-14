# Astratra

Astratra aide à démarrer vite une base SaaS propre, sans réécrire les mêmes
briques à chaque projet : utilisateurs, rôles, sécurité applicative, stores,
dashboard et points d'extension IA.

La v1 pose une base stable pour construire dessus. Elle donne les briques
communes, puis ton projet ajoute son métier, ses écrans, ses règles produit et
ses contraintes de sécurité.

En clair : Astratra te donne le départ solide, pas l'application finale à ta
place.

## Ce Que Ça Donne

Avec une commande, tu peux créer une app qui démarre déjà avec une API, un
dashboard, une auth, des rôles, des settings, des notifications, et des
fichiers prêts à adapter pour MongoDB, PostgreSQL et l'IA.

La v1 veut dire que les packages publics ont des contrats assez stables pour
être utilisés par d'autres projets. Ça ne veut pas dire que ton app est finie,
que tout est sécurisé automatiquement ou qu'Astratra décide à ta place.

`@astratra/store-mongo` et `@astratra/store-postgres` apportent chacun un
adapter de persistance réel avec le même contrat,
`@astratra/saas-kit-ui` apporte l'interface React réutilisable, et
`create-astratra-app` sert de générateur pour créer une app Astratra avec une
commande.

| Package | Rôle |
|---|---|
| [`@astratra/core`](packages/core/README.md) | réponses API, gestion d'erreurs, logs, request id, config env |
| [`@astratra/tooling`](packages/tooling/README.md) | CLI : audit secrets/routes/i18n, lanceur de tests, orchestrateur de déploiement |
| [`@astratra/security`](packages/security/README.md) | primitives JWT/RBAC, rate limiting (mémoire ou Redis optionnel), CSP configurable, WAF heuristique, WebAuthn/passkeys |
| [`@astratra/ai`](packages/ai/README.md) | routing IA multi-provider avec quotas/fallback/Redis optionnel, registre d'outils, boucle d'agent |
| [`@astratra/saas-kit`](packages/saas-kit/README.md) | starter : `createSaasApp()` assemblant users/auth/settings/notifications/dashboard, validation d'entrée intégrée |
| [`@astratra/store-mongo`](packages/store-mongo/README.md) | adapter de persistance réel (MongoDB/Mongoose) pour `usersStore`/`settingsStore` |
| [`@astratra/store-postgres`](packages/store-postgres/README.md) | adapter de persistance réel (PostgreSQL/`pg`) pour `usersStore`/`settingsStore` |
| [`@astratra/saas-kit-ui`](packages/saas-kit-ui/README.md) | dashboard React complet et prêt à l'emploi pour `@astratra/saas-kit`, session JWT en mémoire (`Authorization: Bearer`) |
| [`create-astratra-app`](packages/create-astratra-app/README.md) | générateur CLI pour créer une app Astratra rapidement |
| [`@astratra/prerender`](packages/prerender/README.md) | prérendu SEO générique pour un site Vite + React : un HTML par route, shell SPA préservé |
| [`@astratra/react`](packages/react/README.md) | primitives React nues pour une UI à construire soi-même, session cookie `HttpOnly` sans dashboard imposé — voir son README pour le choix vs `saas-kit-ui` |
| [`examples/dashboard-ui`](examples/dashboard-ui/README.md) | exemple React + Vite consommant `@astratra/saas-kit-ui` et l'API `saas-kit` |

La base est testée, typée et vérifiée localement. Les détails restent dans le
code et les scripts, pas dans le discours marketing.

## Philosophie

Astratra ne décide pas ton métier à ta place. Les choses qui changent d'un
produit à l'autre restent injectées par ton app :

- `createAuthMiddleware` de `@astratra/security` prend un callback optionnel
  `verifySession(decoded)` au lieu d'interroger une collection Mongoose
  codée en dur pour la révocation de session. Il accepte aussi une allowlist
  d'algorithmes JWT, un issuer et une audience.
- `createProviderRouter` de `@astratra/ai` prend un tableau `providers` que
  vous définissez — aucun catalogue Groq/Gemini/Mistral intégré.
- `createSaasApp` de `@astratra/saas-kit` prend `usersStore`,
  `settingsStore`, `notify` et `verifyPassword` — aucune base de données,
  algorithme de hash ou canal de notification fixé.

Les rôles sont toujours de simples strings fournis par le projet
consommateur. Un projet peut utiliser `owner`/`admin`/`member`, un autre
`manager`/`operator`/`client` : rien dans Astratra n'impose un domaine ou une
organisation précise.

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
npm install @astratra/store-postgres pg
npm install @astratra/saas-kit-ui react react-dom
```

## Développement du monorepo

```bash
npm install
npm test --workspaces
```

Tester l'exemple dashboard :

```bash
npm run dev:backend --workspace @astratra/dashboard-ui-example
npm run dev --workspace @astratra/dashboard-ui-example
```

## Exemple : E-Commerce

```bash
npm create astratra-app@latest astratra-shop
cd astratra-shop
npm install
npm run dev:api
npm run dev:web
```

Tu obtiens une base SaaS avec auth, rôles, settings, dashboard et
notifications. Ensuite tu ajoutes le métier e-commerce : catalogue, panier,
commandes, paiements et gestion des produits — via `extendRoutes`, pas en
appelant `app.use()` sur l'app retournée après coup (elle termine déjà sa
propre pile par un 404 générique) :

```js
const app = createSaasApp({
  // ...
  cors: { allowedOrigins: [process.env.WEB_ORIGIN] }, // optionnel, voir README saas-kit
  extendRoutes: (app, { authMiddleware, csrfMiddleware }) => {
    app.get('/api/products', authMiddleware, listProducts);
    app.post('/api/orders', authMiddleware, csrfMiddleware, createOrder);
  }
});
```

## Installation manuelle minimale

Backend :

```bash
npm install @astratra/saas-kit @astratra/security @astratra/core
```

Persistance MongoDB :

```bash
npm install @astratra/store-mongo mongoose
```

Persistance PostgreSQL :

```bash
npm install @astratra/store-postgres pg
```

Dashboard React :

```bash
npm install @astratra/saas-kit-ui react react-dom
```

Primitives React sans dashboard :

```bash
npm install @astratra/react react
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
│   ├── store-postgres/
│   ├── saas-kit-ui/
│   ├── react/
│   └── create-astratra-app/
├── examples/
│   └── dashboard-ui/
├── docs/design/  — un design doc par package, écrit avant l'implémentation
└── LICENSE                    — MIT
```

Chaque package a été construit à partir d'un spec écrit dans `docs/design/`
avant de coder quoi que ce soit, et chaque implémentation a ensuite été
vérifiée à la main : dépendances installées avec un vrai accès réseau, tests
réellement exécutés, code relu, grep pour s'assurer qu'aucune logique métier
n'a fui dans un package.

## Publication mainteneur

Ordre recommandé pour publier une nouvelle version :

```bash
npm publish --workspace @astratra/core --access public
npm publish --workspace @astratra/tooling --access public
npm publish --workspace @astratra/security --access public
npm publish --workspace @astratra/ai --access public
npm publish --workspace @astratra/store-mongo --access public
npm publish --workspace @astratra/store-postgres --access public
npm publish --workspace @astratra/saas-kit --access public
npm publish --workspace @astratra/saas-kit-ui --access public
npm publish --workspace @astratra/react --access public
npm publish --workspace create-astratra-app --access public
```

`examples/dashboard-ui` est un exemple de repo et n'est pas un package npm.

## Positionnement V1

Astratra 1.0 est fait pour aller vite au début d'un projet sans partir dans le
vide. Il convient pour tester une idée, lancer un MVP sérieux ou réutiliser
les mêmes briques entre plusieurs apps.

Il ne remplace pas le code métier, un audit sécurité, une stratégie
d'infrastructure, le paiement, les règles légales ou le design final du
produit.

## Limites connues (V1)

- **Le dashboard (`examples/dashboard-ui`) reste un exemple de repo.** Le package
  publié est `@astratra/saas-kit-ui`; l'exemple ne sert qu'à tester et montrer
  son intégration avec un backend de développement.
- **Deux adapters de persistance réels existent** (`@astratra/store-mongo`,
  `@astratra/store-postgres`), mais pas d'adapter SQL générique (MySQL,
  SQLite) ni de migrations. Le store de credentials WebAuthn reste une
  interface sans implémentation fournie.
- **La boucle d'agent d'`@astratra/ai` n'a ni streaming, ni gestion
  d'images, ni confirmation humaine** avant d'exécuter un outil — ces options
  restent hors périmètre pour une première version (voir
  `packages/ai/README.md`).
- **Le WAF d'`@astratra/security` est une couche heuristique.** Il aide à
  bloquer des patterns évidents, mais ne remplace pas les requêtes
  paramétrées, la sanitation adaptée au contexte ou un WAF réseau.
- **WebAuthn/passkeys reste une primitive d'intégration.** Une app qui veut
  en faire un argument commercial fort doit auditer son intégration complète.
- **Pas de chiffrement au repos ni d'audit de logs de sécurité centralisé**
  fournis par Astratra — à la charge du projet consommateur selon ses
  besoins de conformité.

## Contribuer / étendre

Ajouter un nouveau package en écrivant d'abord son spec de design
(`docs/design/AAAA-MM-JJ-astratra-<nom>-design.md`), en suivant
la même forme que les specs existants : ce qui est extrait, ce qui est
explicitement exclu, et comment ça reste découplé de la logique métier d'un
produit précis.
