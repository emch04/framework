# Astratra — definitions TypeScript pour tous les packages

## Contexte

Les packages Astratra sont ecrits en JavaScript/CommonJS. Sans definitions
TypeScript, un projet consommateur n'obtient ni autocompletion fiable ni
verification de type au moment d'utiliser `@astratra/core`,
`@astratra/security`, `@astratra/ai`, `@astratra/tooling`,
`@astratra/saas-kit` ou `@astratra/store-mongo`.

## Décision

Ajouter des fichiers `.d.ts` ecrits a la main pour chaque package, sans
reecrire l'implementation en TypeScript. C'est l'approche la plus simple et
la moins risquee pour une librairie qui distribue du JavaScript tout en
voulant etre agreable a consommer depuis TypeScript.

Chaque package expose `src/index.d.ts`, reference depuis `package.json` via
`"types": "src/index.d.ts"`, en parallele de `"main": "src/index.js"`.

## Portee : typer l'API publique reelle

### @astratra/core

`apiResponse`, `asyncHandler`, `createLogger`, `AppError`,
`errorMiddleware`, `notFoundMiddleware`, `requestIdMiddleware`,
`validateMiddleware` et `loadEnv`, y compris la forme du schema de config.

### @astratra/security

`createAuthMiddleware(options)`, `authorizeRoles(...roles)`,
`createApiLimiter`, `createLoginLimiter`, `createAccountLimiter`,
`createWafMiddleware`, `createWebauthnService(store, options)`, y compris la
forme exacte de l'adapter WebAuthn.

### @astratra/ai

`createProviderRouter(config)`, la forme des providers et modeles, le retour
`{ ask, getStats, stop }`, `createToolRegistry()` et `runAgentLoop(options)`.

### @astratra/tooling

Typage de `loadConfig`, `DEFAULT_CONFIG` et des fonctions exportees par
`packages/tooling/src/index.js`.

### @astratra/saas-kit

`createSaasApp(options)`, `createMemoryUsersStore`,
`createMemorySettingsStore`, ainsi que les adapters `usersStore`,
`settingsStore`, `notify`, `verifyPassword`, `roles` et `webauthnStore`.

### @astratra/store-mongo

`createMongoUsersStore`, `createMongoSettingsStore`, options de connexion,
types users/settings generiques et methode `disconnect`.

## Exigence de correction

Chaque type doit correspondre au code JavaScript reel, pas seulement aux
README. Apres ajout des `.d.ts`, chaque package garde un petit fichier
`typecheck.ts` qui importe l'API publique et l'utilise avec les formes
attendues. Le script racine `npm run typecheck` lance `tsc --noEmit` pour
attraper les erreurs de declaration.

## Outillage racine

Le monorepo ajoute `typescript` en devDependency et le script :

```json
"typecheck": "tsc --noEmit -p tsconfig.json"
```

La CI execute ce typecheck avec le lint, les tests et le build du dashboard.

## Hors perimetre

- Pas de migration des fichiers d'implementation vers `.ts`.
- Pas d'obligation `strict: true` imposee aux projets consommateurs.
- Pas de generation automatique de types depuis une build.
