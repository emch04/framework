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


## Les briques optionnelles

Le socle généré (`core`, `security`, `ai`, `saas-kit`) couvre les utilisateurs,
l'authentification, les réglages et le tableau de bord. Le reste d'Astratra
s'ajoute à la demande :

```bash
npm create astratra-app@latest my-app -- --with payments,privacy,notify
npm create astratra-app@latest my-app -- --with all
```

| Brique | Ce qu'elle règle |
|---|---|
| `credentials` | clés de service chiffrées en base, modifiables sans redémarrage |
| `entitlements` | plans, droits d'accès, isolation par locataire, invitations |
| `notify` | e-mail, SMS et notifications poussées, transport injecté |
| `payments` | webhooks de paiement : signature, rejeux, exemptions |
| `privacy` | droit d'accès, droit à l'oubli, nettoyage des journaux |
| `resilience` | disjoncteur, cache TTL, relance avec brouillage |
| `i18n-server` | messages du serveur traduits, audit de lisibilité |
| `pdf` | texte borné et tableaux qui se paginent |
| `closure` | clôture de période et archives sans identifiants |
| `client` | session sur 401, garde de route, mots de passe, file hors ligne — *fullstack* |
| `prerender` | prérendu SEO et sitemap tiré de la même liste — *fullstack* |

### Pourquoi ce n'est pas installé par défaut

La plupart de ces packages n'ont **aucune dépendance**, précisément pour qu'on
n'en prenne que ce dont on a besoin. Une application qui veut un moteur PDF n'a
que faire d'un tuyau de webhooks de paiement. Sans `--with`, le projet généré
est exactement celui d'avant.

### Ce qu'une brique écrit

Un fichier d'exemple **câblé pour ce projet** — pas un extrait de README à
recopier — sous `api/bricks/<nom>.js` (ou `web/src/lib/` pour le navigateur).

Rien n'est branché dans `api/server.js`. C'est le même choix que pour
`store-mongo`, déjà scaffoldé sans être branché : une application fraîchement
générée doit démarrer sans configuration, pas réclamer six variables
d'environnement avant son premier `npm run dev:api`. Tu importes la brique le
jour où tu en as besoin.

### Erreurs utiles

Un nom fautif liste les noms valides. Une brique navigateur demandée sur le
gabarit `api` est refusée plutôt que silencieusement ignorée. Et dans les deux
cas, l'échec arrive **avant** qu'un seul fichier soit écrit.

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
