# Câbler des routes personnalisées à côté de `createSaasApp()`

Ce guide couvre un seul problème concret : ton app a besoin de routes qui
n'existent pas dans le kit (`/api/products`, `/api/orders`, peu importe le
domaine), et ces routes doivent quand même bénéficier de l'auth par cookie et
de la protection CSRF que `createSaasApp()` fournit aux routes intégrées.

Deux façons d'y arriver existent. L'une te fait reconstruire la sécurité à la
main ; l'autre te la donne toute montée. Ce guide explique pourquoi choisir la
seconde, et comment s'en sortir si tu as déjà pris la première.

## Le piège : monter un routeur en parallèle

Le réflexe naturel — surtout si on regarde un exemple existant sans lire le
`README` en entier — est de créer son propre routeur et de le monter juste
avant `createSaasApp()` :

```js
const authenticate = createAuthMiddleware({ secret: env.jwtSecret });

app.use('/api/shop', createShopRouter({ authenticate }));
app.use(createSaasApp({ jwtSecret: env.jwtSecret, /* ... */ }));
```

Ça compile, ça a l'air de marcher en dev avec un client qui envoie un
`Authorization: Bearer`. Mais deux couches indispensables vivent normalement
*à l'intérieur* de `createSaasApp()`, et rien ne les monte pour ton routeur
séparé, mounté *avant* :

- **`cookieParserMiddleware()`** — sans lui, `req.cookies` est `undefined`.
  `createAuthMiddleware` tombe alors sur le fallback `Authorization` header,
  et un client qui s'authentifie par cookie (le cas normal pour un
  navigateur) reçoit un 401 silencieux, indiscernable d'un vrai échec
  d'authentification.
- **`csrfMiddleware`** — sans lui, une route mutante que tu ajoutes toi-même
  (`POST`/`PATCH`/`DELETE`) est ouverte aux attaques CSRF classiques, alors
  que les routes intégrées du kit (`/users`, `/settings`, ...) en sont
  protégées par défaut. Rien ne prévient de l'oubli : la route répond, les
  tests manuels avec `curl -b cookie` passent, et le trou reste invisible
  tant que personne ne teste spécifiquement l'absence de jeton CSRF.

Ces deux points sont documentés dans le `README` de `@astratra/security` et de
`@astratra/saas-kit` — mais documentés séparément, dans deux packages
différents, ce qui les rend faciles à manquer si on assemble son app à partir
d'un exemple plutôt que des deux lectures complètes.

## La sortie recommandée : `options.extendRoutes`

`createSaasApp()` accepte `extendRoutes(app, { authMiddleware, csrfMiddleware,
authorizeAdmin, authorizeRoles })` — appelé après que le kit a monté tout son
pipeline de sécurité (cookies, CSP, WAF, rate limit, CSRF), mais avant son
`notFoundMiddleware`. Les middlewares qu'il te passe en argument sont déjà les
bonnes instances, déjà dans le bon ordre :

```js
const app = createSaasApp({
  jwtSecret: env.jwtSecret,
  usersStore,
  settingsStore,
  verifyPassword,
  notify,
  extendRoutes: (app, { authMiddleware, csrfMiddleware, authorizeRoles }) => {
    app.get('/api/products', listProducts);
    app.post('/api/orders', authMiddleware, csrfMiddleware, createOrder);
    app.patch('/api/products/:id', authMiddleware, authorizeRoles('owner', 'admin'), csrfMiddleware, updateStock);
  }
});
```

Avec ce pattern, il n'y a rien à oublier : les deux bugs ci-dessus deviennent
structurellement impossibles, parce que tu n'as plus à reconstruire toi-même
les pièces qui les préviennent.

## Si tu dois quand même monter un routeur séparé

Certains cas légitimes existent (un sous-domaine d'API distinct, un montage
conditionnel, une migration progressive). Dans ce cas, monte explicitement les
mêmes briques, dans le même ordre, avant ton routeur :

```js
const { cookieParserMiddleware, createCsrfCookiePrimer, createCsrfMiddleware } = require('@astratra/security');

app.use(cookieParserMiddleware());   // req.cookies existe pour TOUTES les routes en dessous
app.use(createCsrfCookiePrimer());   // amorce le cookie CSRF sur tout GET/HEAD/OPTIONS

const csrfMiddleware = createCsrfMiddleware();
app.use('/api/shop', createShopRouter({ authenticate, csrfMiddleware }));
app.use(createSaasApp({ /* ... */ }));
```

## Le filet de sécurité, si tu oublies quand même

Depuis `@astratra/security@1.5.0`, `createAuthMiddleware` détecte le cas où
`req.cookies` est `undefined` **et** qu'aucun jeton n'a été trouvé par aucune
autre voie (header `Authorization` compris). Dans ce cas précis, il ne renvoie
plus un 401 silencieux : il transmet une `AuthConfigurationError` explicite à
`next(error)`, à charge pour ton middleware d'erreur de la journaliser ou de
la afficher clairement en développement.

Ce garde-fou ne se déclenche jamais pour une app qui n'authentifie que par
`Authorization: Bearer` — il ne regarde les cookies qu'en dernier recours,
une fois toutes les autres voies épuisées. Il ne remplace pas ce guide : il
transforme un bug silencieux en erreur bruyante, il ne t'évite pas de le
créer.

## Et depuis une application mobile

Une app mobile ne s'authentifie pas par cookie : elle envoie
`Authorization: Bearer`. Trois conséquences pour tes routes personnalisées.

**La CSRF ne s'applique pas, et `createSaasApp()` le sait déjà.** Un navigateur
attache un cookie tout seul à une requête inter-site ; il n'attache jamais un
en-tête `Authorization`. Le middleware CSRF du kit saute donc les requêtes
porteuses d'un Bearer. Si tu montes le tien à la main, reprends ce `skip` —
sinon ton app mobile reçoit des 403 sur chaque écriture.

```js
const csrfMiddleware = createCsrfMiddleware({
  skip: (req) => String(req.headers?.authorization || '').startsWith('Bearer ')
});
```

**`cookieParserMiddleware()` reste nécessaire quand même**, si le même serveur
sert aussi un site web. Les deux clients cohabitent sur les mêmes routes.

**`/auth/refresh` n'a délibérément pas de middleware d'auth.** Le jeton d'accès
est censé être MORT au moment où cette route est appelée — c'est le jeton de
rafraîchissement qui fait office d'identifiant. Si tu ajoutes des routes de
session à toi, applique la même règle : exiger une session valide pour
renouveler une session expirée est une boucle fermée.

## Résumé

| Approche | Sécurité par défaut | Risque d'oubli |
|---|---|---|
| `extendRoutes` | Héritée du kit, déjà montée | Aucun |
| Routeur séparé, briques montées à la main | À reconstruire toi-même | Réel — voir ci-dessus |
| Routeur séparé, briques oubliées | Silencieusement absente | `AuthConfigurationError` la révèle au premier test, plutôt que de rester invisible |
