# create-astratra-app

Generateur CLI pour creer rapidement une application Astratra.

## Installation

Commande recommandee :

```bash
npm create astratra-app@latest my-app
```

Equivalent :

```bash
npx create-astratra-app my-app
```

## Templates

Template complet par defaut :

```bash
npm create astratra-app@latest my-app
```

Il genere :

- une API Express avec `@astratra/saas-kit` ;
- une interface React avec `@astratra/saas-kit-ui` ;
- des fichiers prets a modifier pour `api/security`, `api/stores`,
  `api/db`, `api/ai` et `api/modules` ;
- une base MongoDB optionnelle via `@astratra/store-mongo` et `mongoose` ;
- une base IA optionnelle via `@astratra/ai` avec router, tools et agent ;
- les scripts `dev:api` et `dev:web` ;
- un `.env.example` pour l'API, la securite, CORS, MongoDB et Redis.

Template API seule :

```bash
npm create astratra-app@latest my-api -- --template api
```

## Apres generation

```bash
cd my-app
npm install
npm run dev
```

Tu peux aussi lancer les deux serveurs separement :

```bash
npm run dev:api
npm run dev:web
```

Pour le template `api`, seul `npm run dev:api` est cree.

Par defaut, l'API demande un port libre au systeme et ecrit l'URL choisie dans
`.astratra/api.json`. Lance `dev:api` avant `dev:web` pour que Vite lise la
bonne URL. Laisse `PORT` vide pour garder le choix automatique.

En developpement, l'API accepte automatiquement les origins
`localhost`/`127.0.0.1`, quel que soit le port choisi par Vite. En production,
definis explicitement `CORS_ORIGIN`.

## Fichiers generes importants

- `api/config/env.js` centralise la configuration.
- `api/config/cors.js` gere CORS sans port de developpement fixe.
- `api/security/auth.js`, `api/security/rateLimit.js` et `api/security/waf.js`
  branchent les primitives de securite Astratra.
- `api/stores/memory.js` lance vite avec des stores en memoire.
- `api/db/mongo.js` et `api/stores/mongo.js` preparent MongoDB.
- `api/ai/providers.js`, `api/ai/tools.js` et `api/ai/agent.js` preparent
  la logique IA.
- `api/modules/users.js`, `api/modules/settings.js` et
  `api/modules/notifications.js` isolent la logique metier de depart.

Avant la production, il faut remplacer `JWT_SECRET`, brancher de vrais stores
et utiliser une vraie verification de mot de passe. Definis aussi
`JWT_ISSUER` et `JWT_AUDIENCE` quand l'API sort du developpement local.
