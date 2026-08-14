# @astratra/security

Primitives de sécurité applicative pour l'authentification, l'autorisation,
le rate limiting, une CSP configurable, un WAF heuristique et
WebAuthn/passkeys — génériques et découplées de toute base de données, ORM
ou liste de rôles fixe. Dépend de `@astratra/core`.

Partout où un vrai projet a besoin de persistance (révocation de session,
stockage de credentials WebAuthn, alerte de brute-force), c'est un
callback/adapter injecté, jamais un appel base de données codé en dur.

## Auth JWT + RBAC

```js
const { createAuthMiddleware, authorizeRoles } = require('@astratra/security');

const authMiddleware = createAuthMiddleware({
  secret: process.env.JWT_SECRET,
  legacySecret: process.env.JWT_SECRET_OLD,       // optionnel, pour la rotation de clé
  algorithms: ['HS256'],                          // allowlist explicite
  issuer: 'mon-app',                              // optionnel, recommande en production
  audience: 'mon-api',                            // optionnel, recommande en production
  verifySession: async (decoded) => sessionStore.isActive(decoded)  // vérification de révocation optionnelle
});

app.use('/api', authMiddleware);
app.delete('/api/projects/:id', authorizeRoles('owner', 'admin'), handler);
```

Par défaut, le middleware limite la vérification à `HS256`. Si ton application
utilise un autre algorithme, configure explicitement `algorithms`.

## Sessions cookie HttpOnly + CSRF

```js
const {
  cookieParserMiddleware,
  setSessionCookie,
  clearSessionCookie,
  createCsrfMiddleware,
  DEFAULT_SESSION_COOKIE_NAME // 'astratra_session'
} = require('@astratra/security');

app.use(cookieParserMiddleware()); // peuple req.cookies, sans dépendance cookie-parser

// au login :
setSessionCookie(res, token, { sameSite: 'lax' }); // HttpOnly toujours, Secure sauf NODE_ENV=development

// au logout :
clearSessionCookie(res);

// sur les routes mutantes protégées par cookie :
app.use('/api', authMiddleware, createCsrfMiddleware({
  skip: (req) => Boolean(req.headers.authorization?.startsWith('Bearer ')) // les clients Bearer ne sont pas exposés au CSRF
}));
```

`createAuthMiddleware`'s `extractToken` par défaut lit le cookie
`astratra_session` (ou `token`, pour compatibilité) avant de retomber sur
`Authorization: Bearer`. Si tu personnalises le nom du cookie via
`setSessionCookie(res, token, { name: 'autre_nom' })`, passe le même nom à
`extractToken` — sinon le cookie posé au login ne sera jamais relu.

Le CSRF est un middleware double-submit (cookie non-`HttpOnly` +
header `x-csrf-token`) — à monter explicitement là où tu en as besoin, il
n'est jamais actif tout seul dans ce package. `@astratra/saas-kit` le monte
par défaut sur ses routes protégées, avec bypass automatique pour les
clients `Authorization: Bearer`.

**Piège classique** : si tu ne montes `createCsrfMiddleware` que sur tes
routes mutantes (POST/PATCH/DELETE — le réflexe naturel), la toute première
requête mutante d'un client émet elle-même le cookie CSRF *dans sa propre
réponse* — le client ne peut jamais l'avoir lu à temps, donc elle échoue
systématiquement avec `403 Invalid CSRF token`, même avec des identifiants
valides. Le cookie doit exister *avant* la première requête mutante.

`createCsrfCookiePrimer(options)` résout ça : il amorce le cookie sur toute
requête sûre (GET/HEAD/OPTIONS) sans jamais valider de token, à monter une
seule fois, globalement, avant toutes les routes.

```js
app.use(cookieParserMiddleware());
app.use(createCsrfCookiePrimer()); // amorce le cookie sur tout GET, avant les routes

// ensuite, comme avant : createCsrfMiddleware() valide sur tes routes mutantes
app.use('/api', authMiddleware, createCsrfMiddleware({
  skip: (req) => Boolean(req.headers.authorization?.startsWith('Bearer '))
}));
```

Les deux vérifient le cookie déjà mis en file sur la même réponse avant d'en
émettre un nouveau — les monter tous les deux sur la même requête ne pose
jamais deux cookies différents.

## Révocation de session JWT

```js
const { createAuthMiddleware, createMemoryRevocationStore } = require('@astratra/security');

const revocationStore = createMemoryRevocationStore(); // dev/single-instance ; Redis/DB en prod multi-instance

const authMiddleware = createAuthMiddleware({
  secret: process.env.JWT_SECRET,
  revocationStore // dérive automatiquement verifySession si tu n'en fournis pas un explicite
});

// au logout, pour invalider CE token précis :
await revocationStore.revoke(decodedToken.jti, decodedToken.exp * 1000);

// au "déconnecter tous mes appareils", pour invalider TOUS les tokens de l'utilisateur :
await revocationStore.revokeAllForUser(decodedToken.id, Date.now());
```

Sans `jti` dans le payload du JWT, `revoke()` par token précis ne peut rien
faire — c'est à l'app qui signe le token de générer un `jti` unique par
connexion. `createMemoryRevocationStore()` est un store en mémoire process,
non partagé entre instances : pour une prod multi-instance, fournis ton
propre store (Redis, etc.) qui implémente la même interface
(`revoke`, `isRevoked`, et optionnellement `revokeAllForUser`/
`isRevokedForUser`).

## Rate limiting

```js
const { createApiLimiter, createLoginLimiter, createAccountLimiter } = require('@astratra/security');

app.use(createApiLimiter());                 // 300 req / 15 min par défaut, ignore localhost
app.use('/auth', createLoginLimiter({
  onBlocked: ({ ip, req }) => alertService.notify(`Brute-force depuis ${ip}`)
}));
app.use('/auth/login', createAccountLimiter({ onBlocked: ({ identifier }) => { /* ... */ } }));
```

`createAccountLimiter()` identifie le compte via `req.body.email` par défaut : comme
`createWafMiddleware()`, il doit être monté APRÈS `express.json()`/`express.urlencoded()`.
Avant, `req.body` vaut `undefined` et toutes les tentatives retombent sur la clé
partagée `"unknown"` — la limite par compte disparaît au profit d'une limite
globale partagée par tous les comptes. Un avertissement (`console.warn`, une
seule fois par processus) signale ce cas. Fournir son propre `keyGenerator`
contourne complètement ce point.
```

## WAF

```js
const { createWafMiddleware } = require('@astratra/security');

// IMPORTANT : à monter APRÈS express.json()/express.urlencoded(). Avant, req.body
// vaut undefined et ce middleware n'a rien à inspecter dans le corps de la requête
// — il continue de fonctionner (bloque toujours sur path/query), mais silencieusement
// sans jamais voir un payload dangereux envoyé dans le body. Un avertissement
// (`console.warn`, une seule fois par instance) signale ce cas s'il se produit.
app.use(express.json());
app.use(createWafMiddleware({ message: { success: false, message: 'Requête bloquée.' } }));
```

Cette couche détecte des patterns évidents SQLi/XSS/traversée de chemin/RCE
dans `req.path`, `req.query` et `req.body`. Elle ne remplace pas la
validation des entrées, les requêtes paramétrées, une CSP, la sanitation
adaptée au contexte, ni un WAF/reverse proxy réseau.

## CSP (Content Security Policy)

```js
const { createCspMiddleware } = require('@astratra/security');
app.use(createCspMiddleware());
```

Sans option, la politique par défaut est `default-src 'none';
frame-ancestors 'none'; base-uri 'none'` — adaptée à une API qui ne sert que
du JSON. Pour une app qui sert aussi du HTML/JS (SPA servie par un serveur
Express, pas juste consommée via fetch), surcharge `directives` :

```js
app.use(createCspMiddleware({
  directives: {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'connect-src': ["'self'", 'https://api.mon-app.test']
  }
}));
```

`reportOnly: true` envoie `Content-Security-Policy-Report-Only` au lieu de
bloquer, utile pour tester une politique avant de l'appliquer réellement.

Pour une SPA React/Vite consommée séparément (comme `@astratra/saas-kit-ui`),
la CSP se pose plutôt sur le HTML statique lui-même (balise `<meta
http-equiv="Content-Security-Policy">` injectée au build, jamais en dev — une
CSP statique en dev casse le websocket HMR de Vite). Voir
`examples/dashboard-ui/vite.config.js` pour un exemple qui n'injecte la
balise que sur `vite build`.

## WebAuthn / passkeys

```js
const { createWebauthnService } = require('@astratra/security');

const webauthn = createWebauthnService(store, {
  rpName: 'Mon App',
  recoveryCodeSecret: process.env.RECOVERY_CODE_SECRET
});
```

`store` est un adapter fourni par l'application consommatrice :
`getCredentialsForUser`, `saveCredential`, `getCredentialById`,
`updateCredentialCounter`, `saveChallenge`, `consumeChallenge`, et
optionnellement `saveRecoveryCodes`/`consumeRecoveryCode` pour les codes de
récupération. Aucun Mongoose, aucun rôle fixe autorisé à enregistrer une clé
— ce controle d'acces reste a la charge de l'app consommatrice. Avant de
présenter WebAuthn comme un argument de sécurité fort, prévois une revue de
sécurité externe sur l'intégration complète.

## Tests

```bash
npm test --workspace @astratra/security
```
