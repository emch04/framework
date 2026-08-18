# @astratra/security

Primitives de sécurité applicative pour l'authentification, l'autorisation,
le CORS, le chiffrement de champ, la force du mot de passe, l'anti-injection
Mongo, le rate limiting, une CSP configurable, un WAF heuristique et
WebAuthn/passkeys — génériques et découplées de toute base de données, ORM
ou liste de rôles fixe. Dépend de `@astratra/core`.

Partout où un vrai projet a besoin de persistance (révocation de session,
stockage de credentials WebAuthn, alerte de brute-force), c'est un
callback/adapter injecté, jamais un appel base de données codé en dur.

## Chiffrement de champ (au repos)

Astratra ne s'intercale jamais entre ton app et ta base de données — rien
en amont ne chiffre tes données à ta place. `createFieldCipher` fournit une
primitive AES-256-GCM authentifiée (une donnée altérée ou une mauvaise clé
échoue au déchiffrement plutôt que de retourner du charabia silencieusement)
pour chiffrer un champ sensible avant de l'écrire dans n'importe quel store :

```js
const { createFieldCipher, generateFieldEncryptionKey } = require('@astratra/security');

// Une fois, à la mise en place — garde la clé en secret (variable d'env),
// jamais dans le dépôt. La faire tourner rend les anciennes valeurs
// indéchiffrables : prévois un plan de ré-encryption si tu veux la changer.
console.log(generateFieldEncryptionKey());

const cipher = createFieldCipher({ key: process.env.FIELD_ENCRYPTION_KEY });
const stored = cipher.encrypt('4242-4242-4242-4242'); // string unique, safe pour n'importe quel champ/colonne
const plain = cipher.decrypt(stored);
```

## CORS

```js
const { createCorsMiddleware } = require('@astratra/security');

// À monter EN PREMIER, avant tout autre middleware — les en-têtes CORS,
// y compris sur la réponse de preflight OPTIONS, doivent être posés avant
// qu'un autre handler ne puisse court-circuiter la requête.
app.use(createCorsMiddleware({
  allowedOrigins: (process.env.CORS_ORIGIN || '').split(',').filter(Boolean)
}));
```

Astratra n'impose aucune politique CORS fixe — les origines autorisées sont
spécifiques à chaque projet. `@astratra/saas-kit` expose cette primitive via
`options.cors`, montée automatiquement au bon endroit — voir son README.

Origines `http://127.0.0.1`/`http://localhost` (tout port) autorisées par
défaut hors `NODE_ENV=production`, désactivable via `allowDevOrigins: false`.
`credentials: false` retire `Access-Control-Allow-Credentials` si tu n'as
pas besoin des cookies cross-origin.

## Hachage de mot de passe

`verifyPassword` reste un callback fourni par l'app consommatrice —
Astratra ne décide toujours pas comment tu authentifies un utilisateur.
Mais avant, aucune primitive n'existait pour le hachage lui-même : rien
n'empêchait un `===` en clair ou un MD5 sans sel. `hashPassword`/
`verifyPasswordHash` utilisent scrypt (natif à Node, aucune dépendance
bcrypt/argon2 à ajouter), avec sel aléatoire et comparaison à temps
constant :

```js
const { hashPassword, verifyPasswordHash } = require('@astratra/security');

// à l'inscription
const passwordHash = await hashPassword(rawPassword);
await usersStore.create({ email, passwordHash });

// dans verifyPassword passé à createSaasApp
const app = createSaasApp({
  // ...
  verifyPassword: async (user, password) => verifyPasswordHash(password, user.passwordHash)
});
```

Le sel et le facteur de coût scrypt voyagent avec la chaîne retournée — pas
besoin de colonnes séparées. `verifyPasswordHash` ne lève jamais d'exception
sur une entrée invalide (mot de passe erroné, hash étranger ou corrompu) :
elle retourne toujours `false`, donc un appelant peut traiter le résultat
comme un booléen sans `try/catch`.

### Force du mot de passe

`hashPassword` ne jugeait jamais si un mot de passe valait la peine d'être
haché — n'importe quel projet consommateur pouvait accepter `"aaaaaaaa"` ou
`"12345678"` comme nouveau mot de passe. `isStrongPassword` comble ce trou,
sans imposer de message d'erreur ni de langue (chaque app garde la main sur
son propre texte) :

```js
const { isStrongPassword } = require('@astratra/security');

if (!isStrongPassword(nouveauMotDePasse)) {
  return res.status(400).json({ message: 'Mot de passe trop faible.' });
}
```

8 caractères minimum + majuscule + minuscule + chiffre + caractère spécial,
toutes exigences activées par défaut et individuellement désactivables :

```js
isStrongPassword(candidat, { minLength: 12, requireSpecial: false });
```

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

**Session par cookie sans `cookieParserMiddleware()` monté en amont** :
`createAuthMiddleware` a besoin de `req.cookies` pour lire un cookie de
session. Si aucun token n'est trouvé (ni cookie, ni header `Authorization`)
**et** que `req.cookies` est `undefined` — c'est-à-dire que
`cookieParserMiddleware()` (section suivante) n'a jamais tourné — le
middleware ne renvoie pas un 401 silencieux : il transmet une
`AuthConfigurationError` à `next(error)`, pour distinguer une vraie
absence de session d'un pipeline mal monté. Un routeur monté séparément de
`createSaasApp()` (au lieu de passer par `options.extendRoutes`) est le cas
le plus courant où ça arrive — voir
[`docs/guides/custom-routes-wiring.md`](../../docs/guides/custom-routes-wiring.md).

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

## Anti-injection Mongo (opérateurs `$`/`.`)

```js
const { createMongoSanitizeMiddleware } = require('@astratra/security');
app.use(createMongoSanitizeMiddleware());
```

Retire de `req.body`/`req.query`/`req.params` toute clé qui commence par
`$` ou contient un `.` — les opérateurs Mongo (`$gt`, `$ne`, `$where`...) et
les chemins imbriqués. Trouvé sur un projet consommateur réel : une route
passait `req.query.date` tel quel dans un filtre Mongoose ; comme le
parseur `qs` d'Express transforme `?date[$gt]=` en objet imbriqué plutôt
qu'en chaîne, ce paramètre non typé devenait un opérateur Mongo choisi par
l'appelant. Aucune requête légitime n'envoie une clé JSON littéralement
préfixée par `$` ou contenant un point — sans risque de faux positif sur un
usage normal.

Mute les objets en place plutôt que de réassigner `req.query` (getter
seul sur certaines configurations Express/routeur — une réassignation y
échouerait silencieusement ou lèverait selon la version).

Monté par défaut, sans configuration, par `createSaasApp()` (voir
`@astratra/saas-kit`) — pas besoin d'y penser route par route.

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

## En-têtes de sécurité (au-delà de CSP)

```js
const { createSecurityHeadersMiddleware } = require('@astratra/security');
app.use(createSecurityHeadersMiddleware());
```

Complète CSP avec le reste du set standard, chacun avec une valeur par
défaut sûre pour n'importe quel projet — contrairement à CORS, rien ici ne
demande une décision spécifique au projet, donc `@astratra/saas-kit` le
monte sans condition, comme CSP :

- `X-Frame-Options: DENY` — anti clickjacking
- `X-Content-Type-Options: nosniff` — anti détection de type MIME
- `Referrer-Policy: strict-origin-when-cross-origin` — limite la fuite d'URL vers des origines tierces
- `Permissions-Policy` — refuse géoloc/caméra/micro/paiement par défaut
- `Strict-Transport-Security` (HSTS) — actif automatiquement seulement si
  `NODE_ENV=production` (le forcer en dev casse le HTTP local)

Chaque en-tête est désactivable/personnalisable individuellement
(`frameOptions: false`, `hsts: { maxAge, includeSubDomains }`, etc.).

## Journal d'événements de sécurité

```js
const { createSecurityAuditLogger } = require('@astratra/security');
app.use(createSecurityAuditLogger());
```

Avant, aucune des autres couches (rejet CSRF, blocage WAF, rate limit, échec
JWT) ne journalisait quoi que ce soit — une tentative d'attaque restait
invisible tant qu'elle n'avait pas réussi. Plutôt que d'accrocher un log à
chaque middleware séparément, celui-ci observe la réponse : toute requête
qui se termine en `401`/`403`/`429` (configurable via `statusCodes`) produit
une ligne structurée, peu importe quelle couche l'a produite.

```js
app.use(createSecurityAuditLogger({
  log: (message, event) => myLogger.warn(message, event), // par défaut : @astratra/core createLogger
  statusCodes: [401, 403, 429]
}));
```

`@astratra/saas-kit` le monte par défaut ; `options.securityAudit: false`
le désactive.

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

Pour développer/tester sans écrire de store tout de suite,
`createMemoryWebauthnStore()` fournit une implémentation en mémoire
conforme au contrat complet — credentials perdues au redémarrage, à
remplacer par une vraie base avant la prod :

```js
const { createWebauthnService, createMemoryWebauthnStore } = require('@astratra/security');

const webauthn = createWebauthnService(createMemoryWebauthnStore(), {
  rpName: 'Mon App',
  recoveryCodeSecret: process.env.RECOVERY_CODE_SECRET
});
```

## Tests

```bash
npm test --workspace @astratra/security
```
