# Astratra — Design @astratra/saas-kit-ui (V0)

## Contexte

La promesse d'Astratra inclut un starter frontend fourni avec un nouveau
projet SaaS. Cette surface est maintenant separee en deux parties : le package
publiable `@astratra/saas-kit-ui`, et l'exemple de repo `examples/dashboard-ui`
qui sert a tester l'integration avec un backend de developpement.

## Décision : package UI + exemple de repo

La V0 publie `@astratra/saas-kit-ui`, une interface React reutilisable qui
consomme l'API HTTP generique de `@astratra/saas-kit` :

- `POST /auth/login`
- `GET /auth/me`
- `GET /users`
- `GET /settings`
- `PATCH /settings/:key`
- `GET /dashboard/summary`

`examples/dashboard-ui/` reste une app React + Vite executable. Elle importe
`AstratraDashboardApp` depuis `@astratra/saas-kit-ui` et demarre un petit
backend Express pour verifier le parcours complet.

## Pile technique

React, CSS Modules et CSS global. Le package ne depend pas de Vite ; Vite est
seulement utilise par l'exemple de repo. Le package expose le code source ESM
pour laisser le bundler de l'application finale compiler React et les CSS.

## Portee : 4 ecrans

1. **Connexion** : formulaire email/mot de passe, appel `POST /auth/login`,
   stockage du JWT en memoire via contexte React, puis redirection vers le
   dashboard.
2. **Tableau de bord** : appel `GET /dashboard/summary`, affichage de `userCount`
   et `roleBreakdown` avec HTML/CSS simple, sans bibliotheque de graphiques.
3. **Utilisateurs** : appel `GET /users`, tableau email/role et formulaire
   minimal de creation via `POST /users`. Les routes restent protegees cote
   serveur ; l'UI affiche explicitement l'etat `403`.
4. **Parametres** : appel `GET /settings`, affichage key/value et sauvegarde
   par ligne via `PATCH /settings/:key`.

Navigation simple : dashboard, utilisateurs, parametres, deconnexion. Un
garde d'acces renvoie vers la connexion lorsqu'il n'y a pas de token ou
qu'une requete retourne `401`.

## Configuration

`VITE_API_URL` pointe vers le backend de l'application. `.env.example` est
commite dans l'exemple ; le vrai `.env` reste ignore par Git.

## Hors V0

- Pas de design system complet.
- Pas de bibliotheque d'etat globale type Redux ou Zustand.
- Pas de routeur client complexe ; un etat de vue suffit pour ce scope.
- Pas de tests visuels automatises. La barre de verification est :
  `vite build`, tests API, et essai manuel contre un backend `saas-kit`.

## Vérification

1. `npm run build --workspace @astratra/dashboard-ui-example` doit passer.
2. Le backend de developpement se lance avec
   `npm run dev:backend --workspace @astratra/dashboard-ui-example`.
3. Les ecrans connexion, dashboard, utilisateurs et parametres doivent
   fonctionner contre ce backend.
