# create-astratra-app

Générateur CLI pour créer vite une app Astratra.

## Installation

Commande recommandée :

```bash
npm create astratra-app@latest my-app
```

Équivalent :

```bash
npx create-astratra-app my-app
```

## Templates

Template complet par défaut :

```bash
npm create astratra-app@latest my-app
```

Il crée une base prête à lancer avec :

- une API Express avec `@astratra/saas-kit` ;
- une interface React avec `@astratra/saas-kit-ui` ;
- des fichiers prêts à modifier pour `api/security`, `api/stores`,
  `api/db`, `api/ai` et `api/modules` ;
- une base MongoDB optionnelle via `@astratra/store-mongo` et `mongoose` ;
- une base IA optionnelle via `@astratra/ai` avec router, tools et agent ;
- les scripts `dev:api` et `dev:web` ;
- un `.env.example` pour l'API, la sécurité, CORS, MongoDB et Redis.

Template API seule :

```bash
npm create astratra-app@latest my-api -- --template api
```

## Après Génération

```bash
cd my-app
npm install
npm run dev
```

Tu peux aussi lancer les deux serveurs séparément :

```bash
npm run dev:api
npm run dev:web
```

Pour le template `api`, seul `npm run dev:api` est créé.

Par défaut, l'API demande un port libre au système et écrit l'URL choisie dans
`.astratra/api.json`. Lance `dev:api` avant `dev:web` pour que Vite lise la
bonne URL. Laisse `PORT` vide pour garder le choix automatique.

En développement, l'API accepte automatiquement les origins
`localhost`/`127.0.0.1`, quel que soit le port choisi par Vite. En production,
définis explicitement `CORS_ORIGIN`.

## Fichiers Utiles

- `api/config/env.js` centralise la configuration.
- `api/config/cors.js` gère CORS sans port de développement fixe.
- `api/security/auth.js`, `api/security/rateLimit.js` et `api/security/waf.js`
  branchent les primitives de sécurité Astratra.
- `api/stores/memory.js` lance vite avec des stores en mémoire.
- `api/db/mongo.js` et `api/stores/mongo.js` préparent MongoDB.
- `api/ai/providers.js`, `api/ai/tools.js` et `api/ai/agent.js` préparent
  la logique IA.
- `api/modules/users.js`, `api/modules/settings.js` et
  `api/modules/notifications.js` isolent la logique métier de départ.

Avant la production, il faut remplacer `JWT_SECRET`, brancher de vrais stores
et utiliser une vraie vérification de mot de passe. Définis aussi
`JWT_ISSUER` et `JWT_AUDIENCE` quand l'API sort du développement local.
