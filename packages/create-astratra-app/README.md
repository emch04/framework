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
- les scripts `dev:api` et `dev:web` ;
- un `.env.example` avec le port API, le host et les origins CORS de
  developpement.

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
bonne URL. Pour forcer un port precis, utilise par exemple
`PORT=4000 npm run dev:api`.

En developpement, l'API accepte automatiquement les origins
`localhost`/`127.0.0.1`, quel que soit le port choisi par Vite. En production,
definis explicitement `CORS_ORIGIN`.

Avant la production, il faut remplacer `JWT_SECRET`, brancher de vrais stores
et utiliser une vraie verification de mot de passe.
