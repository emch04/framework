# @astratra/security

Primitives de sécurité applicative pour l'authentification, l'autorisation,
le CORS, le chiffrement de champ, la force du mot de passe, l'anti-injection
Mongo, le rate limiting, une CSP configurable, un WAF heuristique et
WebAuthn/passkeys — génériques et découplées de toute base de données, ORM
ou liste de rôles fixe. Dépend de `@astratra/core`.

Partout où un vrai projet a besoin de persistance (révocation de session,
stockage de credentials WebAuthn, alerte de brute-force), c'est un
callback/adapter injecté, jamais un appel base de données codé en dur.

## Signer les appels entre tes propres services

La porte d'entrée est gardée — sessions, jetons, CORS. Les couloirs entre tes
services, eux, ne le sont généralement pas : l'un appelle l'autre sur le réseau
et celui qui reçoit fait confiance à ce qui arrive, parce que « c'est interne ».
Ça l'est jusqu'au jour où autre chose atteint ce port.

```js
const { createServiceSigner } = require('@astratra/security');

const signer = createServiceSigner({
  secret: process.env.INTERNAL_SERVICE_KEY,
  // Sans durée de validité, une charge utile capturée fonctionne pour
  // toujours : qui observe UN appel interne signé peut le rejouer quand il
  // veut. Mets-la.
  maxAgeMs: 30_000,
});

// Côté appelant
await fetch(url, { headers: { ...signer.headers({ id, role, tenant }) } });

// Côté appelé
const check = signer.verifyHeaders(req.headers);
if (!check.valid) return res.status(401).json({ message: 'Appel interne non signé.' });
```

Trois détails qui comptent :

**L'horodatage est À L'INTÉRIEUR de la chaîne signée.** Envoyé à côté, un
attaquant le réécrirait simplement.

**La signature est vérifiée AVANT que la charge utile soit analysée.** Analyser
d'abord, c'est faire tourner ton analyseur JSON sur ce qu'un attaquant a envoyé.

**Les clés sont triées avant signature.** Un service construit `{ id, role }`,
l'autre reconstruit `{ role, id }` depuis une ligne de base : `JSON.stringify`
produirait deux chaînes différentes pour la même donnée, et la vérification
échouerait par intermittence d'une façon qui ressemble à un problème réseau.

## Un journal qui montre qu'on l'a modifié

Un journal ordinaire est une liste d'affirmations. Qui a accès à la base peut
changer une ligne ou en supprimer une, et rien dans le résultat n'a l'air faux
— précisément au moment où tu as le plus besoin de lui faire confiance.

Le chaînage règle ça : chaque entrée porte l'empreinte de la précédente, donc
elle dépend de tout l'historique derrière elle.

```js
const { createAuditChain } = require('@astratra/security');

const chain = createAuditChain({ store });

await chain.record({ type: 'payment.validated', actor: userId, message: '…' });

const { intact, failure } = await chain.verify();
// failure.reason === 'altered' -> le contenu ne correspond plus à son empreinte
// failure.reason === 'broken'  -> une entrée a été supprimée ou insérée
```

Distinguer les deux compte : un contenu réécrit est une falsification, un
maillon rompu veut dire qu'on a retiré ou glissé quelque chose.

Modifier une entrée **et** recalculer sa propre empreinte ne suffit pas : tout
ce qui suit pointe encore sur l'ancienne valeur. Cacher un changement oblige à
réécrire toute la suite — et si le journal est aussi copié hors machine, même
pas.

Une colonne ajoutée plus tard — un index, un drapeau de réplication — ne
casse pas la chaîne : seuls les champs signés alimentent l'empreinte.

**L'écriture ne lève jamais.** Perdre la trace est grave ; perdre le paiement
qu'elle enregistrait l'est davantage. L'échec est signalé, bruyamment.

`createMemoryAuditStore()` fournit une chaîne en mémoire pour les tests. En
production, le store est le tien — et copier le journal hors machine est ce qui
transforme « visible » en « irréfutable ».

Ce mécanisme rend la falsification **visible**, pas impossible. C'est la
promesse honnête, et c'est celle qui vaut la peine d'être faite.

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

## Rester connecté (jetons de rafraîchissement)

Un jeton d'accès est court par choix : c'est cette brièveté qui limite les
dégâts d'un vol. Le prix, c'est qu'il faut quelque chose pour le renouveler —
et ce quelque chose est un identifiant à longue vie. Mal fait, on a remplacé un
risque d'une heure par un risque d'un mois.

```js
const refreshTokens = createRefreshTokenService({
  store: createMemoryRefreshTokenStore(),
  ttlMs: 30 * 24 * 60 * 60 * 1000
});

const { token, familyId } = await refreshTokens.issue({ userId: user.id });
const next = await refreshTokens.rotate(token);   // l'ancien est mort
await refreshTokens.revokeAllForUser(user.id);    // mot de passe changé
```

**Ce n'est pas un JWT.** Le jeton ne prouve rien par lui-même et ne porte aucune
information : c'est une chaîne aléatoire, qui n'a de sens que comme ligne dans
un magasin. C'est ce qui le rend **révocable** — un jeton signé reste valable
jusqu'à son expiration, quoi qu'on en pense entre-temps.

**Il est rangé en empreinte, jamais en clair.** Une base volée ne donne alors
aucune session. Le jeton a toute l'entropie voulue, donc un SHA-256 suffit : il
n'y a rien à casser par force brute, et un hachage lent à chaque renouvellement
ne serait qu'une surface de déni de service.

**Il tourne à chaque usage.** Le jeton présenté est consommé, un neuf prend sa
place. Un jeton vu deux fois est donc une anomalie, pas un cas normal.

**Un rejeu tue la famille.** Quand un jeton déjà consommé revient, quelqu'un en
a gardé une copie : le client légitime est passé à autre chose depuis. Refuser
ce seul jeton laisserait le voleur avec celui **en cours** — c'est donc toute la
chaîne issue de cette connexion qui est révoquée. La vraie personne se
reconnecte : c'est le prix correct d'une session volée.

### L'alphabet, et le bug qui l'a imposé

Les jetons sont en **hexadécimal**, pas en base64url. Ce dernier contient `-`,
donc environ un jeton sur cent trente portait un `--` quelque part. Le WAF
(section plus bas) lit `--` dans un corps de requête comme un commentaire SQL et
répond 403 : cette session ne pouvait alors **plus jamais** être renouvelée,
puisque le client rejoue le même jeton et se fait bloquer à chaque fois.
L'utilisateur était déconnecté pour des raisons que personne ne savait
reproduire.

Un identifiant ne doit jamais pouvoir être lu comme du contenu.

## Codes uniques

```js
const { createRandomCode, generateUniqueCodes } = require('@astratra/security');

createRandomCode();                       // "A1B2C3D4E5"
createRandomCode({ prefix: 'ete2026' });  // "ETE2026-A1B2C3D4E5"
```

Génère un token à usage unique via `crypto.randomBytes` (jamais `Math.random`) —
utile pour un code promo, une invitation, une carte cadeau... Le préfixe est
assaini (lettres/chiffres uniquement, tronqué à 12 caractères) avant d'être
collé au token, pour ne jamais casser le format si le préfixe vient d'une
saisie admin.

Pour générer plusieurs codes garantis uniques :

```js
const codes = await generateUniqueCodes({
  quantity: 20,
  prefix: 'PROMO',
  // Optionnel : vérifie l'unicité contre TON store avant de renvoyer quoi
  // que ce soit — jamais après une tentative d'insertion, donc aucun risque
  // de double insertion partielle si un nouvel essai est nécessaire.
  isTaken: async (candidates) => {
    const existing = await MyCodeModel.find({ code: { $in: candidates } }).select('code');
    return new Set(existing.map((doc) => doc.code));
  }
});
```

Une collision entre deux codes générés par `crypto.randomBytes(5)` (défaut,
~1 billion de combinaisons) est déjà astronomiquement improbable ; `isTaken`
ne fait que fermer ce cas rarissime proprement (régénère seulement les codes
rejetés, jusqu'à `maxAttempts`, défaut 5) plutôt que de laisser une erreur de
contrainte unique remonter au milieu d'une insertion.

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

### Store Redis namespacé

Par défaut, `redisUrl` seul suffit à activer un store Redis partagé entre
tous les limiteurs. Pour isoler les compteurs par domaine (connexion,
réservation, avis...) sur la même instance Redis, construis le store avec
un préfixe et passe-le via `options.store` :

```js
const { createApiLimiter, createLoginLimiter, createRedisRateLimitStore } = require('@astratra/security');

const loginStore = createRedisRateLimitStore({
  redisUrl: process.env.REDIS_URL,
  prefix: 'mon-app:rate:connexion:'
});
app.use('/auth', createLoginLimiter({ store: loginStore }));

const bookingStore = createRedisRateLimitStore({
  redisUrl: process.env.REDIS_URL,
  prefix: 'mon-app:rate:reservation:'
});
app.use('/bookings', createApiLimiter({ store: bookingStore }));
```

`prefix` est entièrement libre et défini par le projet consommateur — Astratra
ne connaît aucun nom de domaine métier. Si Redis n'est pas joignable au
démarrage ou perd la connexion, le store bascule automatiquement sur un
store en mémoire process (mêmes garanties que le store par défaut sans
`prefix`), donc aucune configuration additionnelle n'est nécessaire pour
gérer l'indisponibilité de Redis.

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

## Fichiers privés : un lien signé par lecteur

Une balise `<img>` ou un lecteur audio n'envoient aucun en-tête
`Authorization` : un fichier privé ne peut donc pas être protégé par la seule
session, l'adresse elle-même doit porter un laissez-passer. C'est là qu'était le
vrai défaut.

**Le défaut.** Un message avec pièce jointe était diffusé en direct avec son
lien déjà signé — signé pour l'**expéditeur**, puisque c'est sa requête qui
produisait le message. Le destinataire ouvrait le fichier en empruntant
l'identité de l'autre, et le laissez-passer expirait un quart d'heure plus tard
dans une conversation restée ouverte. D'où la règle : **une diffusion ne porte
que le chemin** ; chaque lecteur demande **son** lien au moment d'afficher, et
le serveur revérifie le droit de lire à cette demande.

```js
const {
  createPrivateFileLinks, createPrivateFileHandler,
  serializeForReader, serializeForBroadcast,
  resolveStoredFile, privateFileHeaders
} = require('@astratra/security');

const links = createPrivateFileLinks({
  secret: process.env.FILE_LINK_SECRET,      // dédié, 32 caractères au moins
  basePath: '/api/files',
  // relu à chaque vérification : « déconnecter partout » tue aussi les liens déjà remis
  accountVersion: async (accountId) => (await users.findById(accountId))?.tokenVersion ?? null
});

app.get('/api/files/:kind/:id', createPrivateFileHandler({
  links,
  authenticate: authMiddleware,
  loadFile: (kind, id) => files[kind].findById(id),
  canRead: (reader, kind, file) => policy.canRead(reader, kind, file),   // ta règle d'accès
  loadReader: (accountId) => users.findById(accountId),
  send: (file, req, res) => {
    const local = resolveStoredFile(PRIVATE_ROOT, file.storedName);
    if (!local) return res.status(404).json({ success: false, code: 'FILE_UNAVAILABLE' });
    res.set(privateFileHeaders({ mime: file.mime, fileName: file.name }));
    return res.sendFile(local, { dotfiles: 'deny' });
  }
}));

// Réponse à UNE personne : ses propres liens.
res.json(serializeForReader(messages, { links, reader: req.user, kind: 'messages', clearWhenDeleted: ['fileThumb'] }));
// Socket, push, webhook : le chemin seul.
io.to(room).emit('message', serializeForBroadcast(message, { links, kind: 'messages', clearWhenDeleted: ['fileThumb', 'content'] }));
```

Les trois portes de la route, dans cet ordre :

| Requête | Qui lit | Rend |
|---|---|---|
| `?ticket=…` | le compte nommé dans le laissez-passer | le fichier |
| `?link=1` | la **session** (jamais un laissez-passer) | le lien de l'appelant |
| rien | la session | le fichier |

**Un laissez-passer n'en fabrique jamais un autre.** `?link=1` accompagné d'un
`ticket` passe par la session : sinon un lien fuité se renouvellerait sans fin.

**Le lien est stable pendant un pas.** Signé « maintenant », il changeait à
chaque réponse pour le même fichier : un fil relu toutes les cinq secondes
rendait une adresse neuve à chaque fois, aucun cache ne reconnaissait l'image,
et le lecteur audio repartait de zéro — un vocal ne se terminait jamais (202
requêtes en une minute, 79 Mo servis pour 600 Ko de fichiers). Le laissez-passer
est calé sur un pas de quinze minutes et vit deux pas.

**Hexadécimal de bout en bout.** Un JWT est en base64url, donc contient `-` :
environ un laissez-passer sur cent portait un `--`, que le WAF lit comme un
commentaire SQL dans la chaîne de requête. Ce fichier répondait alors 403 à
cette personne pendant tout le pas, sans que personne sache le reproduire.

**Ce qui est vérifié :** la signature (avant toute lecture du contenu),
l'expiration (un laissez-passer daté du futur est refusé), le fichier exact
(`kind` et `id`), le compte et sa version de session. Un refus d'accès répond le
même 404 qu'un fichier absent ; les corps ne portent qu'un `code`, jamais de
texte — les mots appartiennent à ton catalogue.

**Parcours de dossier.** `resolveStoredFile` n'accepte qu'un nom nu (ni
séparateur, ni NUL) et exige que le chemin résolu soit strictement **dans** la
racine : `.`, `..` et toute forme non prévue sont refusés.

**Un élément supprimé perd son adresse ET son aperçu, à toutes les
profondeurs.** Une citation (`replyTo`) d'un message supprimé porte le même
risque que le message lui-même.

## Appareils de connexion et alertes de changement

```js
const {
  createLoginDeviceTracker, createMemoryLoginDeviceStore,
  createChangeAlerts, createSecurityAlerter
} = require('@astratra/security');

const devices = createLoginDeviceTracker({
  store: createMemoryLoginDeviceStore(),     // upsert ATOMIQUE en prod (index unique)
  secret: process.env.DEVICE_FINGERPRINT_SECRET,
  notify: (account, event) => notifications.create(account.id, { key: 'security.new_login_device' })
});
// APRÈS avoir accordé la session ; ne lève jamais.
devices.record(user, { ip: req.ip, userAgent: req.headers['user-agent'] });

const changes = createChangeAlerts({
  send: ({ to, key, locale, detail }) => mailer.send(to, t(locale, `${key}.subject`), t(locale, `${key}.body`, { detail }))
});
await changes.alert(user, 'password', { to: user.email });
await changes.alert(user, 'email', { previousEmail: before, newEmail: user.email });
await changes.alert(user, 'trusted-device', { to: user.email, detail: 'iPhone (iOS)' });
```

**« Appareil » = agent utilisateur + famille d'adresse** (/16 en IPv4, /48 en
IPv6). Un /24 changeait à chaque bascule d'antenne d'un opérateur mobile : une
alerte par jour pour son propre téléphone, et une alerte quotidienne n'est plus
lue. L'IPv6 est **développée** avant d'être coupée : `2001:db8::5` et
`2001:db8:0:1::5` sont le même /48. Seule une empreinte HMAC est gardée, bornée
par compte. Aucune alerte à la toute première connexion.

**Un changement d'adresse prévient l'ANCIENNE.** La nouvelle est déjà entre les
mains de qui a fait la manœuvre. Une **première** adresse ne prévient personne.

**Un envoi raté ne fait jamais échouer le changement** : le mot de passe est
déjà modifié ; une erreur ferait croire le contraire.

**Aucun texte ici.** Le module décide QUAND prévenir et QUI ; tu reçois une clé
de catalogue (`security.change.password`, `…email`, `…factor-added`,
`…factor-removed`, `…recovery-codes`, `…trusted-device`) et la langue du compte.
Pas de bouton d'action dans une alerte : elle ne doit pas apprendre à cliquer
sur un lien reçu par courriel.

`createSecurityAlerter({ channels })` diffuse une alerte **d'exploitation**
(webhook, boîte dédiée) : un canal en panne ne fait pas taire les autres, et
rien ne remonte à la requête qui l'a levée.

## Appareil de confiance (Face ID, empreinte)

Se reconnecter par le verrou du téléphone plutôt que par le mot de passe, sur
un appareil qui s'est déjà connecté.

**Un secret roté, pas une paire de clés.** Une paire n'apporte quelque chose que
si la clé privée reste dans la puce sécurisée et ne signe qu'après la biométrie
— ce qui demande un module natif. En JavaScript, elle serait rangée dans le même
trousseau que le secret, et volée de la même façon. Le secret roté donne en plus
ce que la paire ne donne pas : **un secret copié puis rejoué se voit**.

```js
const { createTrustedDeviceService, createMemoryTrustedDeviceStore, TrustedDeviceError } = require('@astratra/security');

const trusted = createTrustedDeviceService({
  store: createMemoryTrustedDeviceStore(),   // consume() = compare-and-swap ATOMIQUE en prod
  pepper: process.env.TRUSTED_DEVICE_PEPPER,
  onReplay: async ({ accountId }) => {       // on ne sait pas qui est le vrai : tout tombe
    await refreshTokens.revokeAllForUser(accountId);
    await alerter.send({ level: 'FATAL', type: 'trusted_device.replay', meta: { accountId } });
  }
});

// POST /trusted-devices — session COMPLÈTE exigée
const device = await trusted.enroll({
  accountId: user.id,
  credentialStamp: user.passwordHash,        // mot de passe changé = appareil éteint
  requireSecondFactor: policy.needsMfa(user),
  secondFactorVerified: req.user.mfaVerified,
  deviceName: req.body.deviceName,
  platform: req.body.platform
});
await changes.alert(user, 'trusted-device', { to: user.email, detail: device.deviceName });

// POST /trusted-device/session — sans session
try {
  const next = await trusted.exchange(req.body, { loadAccount: async (id) => {
    const u = await users.findById(id);
    return u && { credentialStamp: u.passwordHash, disabled: u.suspended || u.deletionPending };
  } });
  const session = await issueSession(next.accountId, { mfaVerified: next.secondFactorVerified });
  res.json({ ...session, trustedDevice: { deviceId: next.deviceId, secret: next.secret } });
} catch (error) {
  if (error instanceof TrustedDeviceError) return res.status(error.statusCode).json({ success: false, code: error.code });
  throw error;
}
```

Si ton émission de session refuse (compte suspendu, rôle coupé), appelle
`trusted.revoke(next.id, 'session-refused')`. Branche `trusted.revokeAll(id)` sur
« déconnecter partout », le changement de mot de passe et la suppression de
compte ; la **déconnexion simple garde l'appareil** — c'est tout son intérêt.

Garanties : empreinte HMAC seule en base ; enrôlement depuis une session
complète ; secret consommé une fois, de façon atomique ; rejeu → appareil
révoqué + `onReplay` ; lien au mot de passe en vigueur ; 30 jours sans usage ;
10 essais par appareil et par quart d'heure (monte **aussi**
`createLoginLimiter` par adresse) ; cinq appareils au plus ; même erreur pour
tout échec. Un appareil révoqué est simplement refusé : le traiter en rejeu
déconnecterait son propriétaire partout pour un vieux téléphone.

### Le protocole, côté téléphone (`@astratra/native`)

Les deux paquets parlent le même contrat :

| Étape | Téléphone | Serveur |
|---|---|---|
| Activer | `gate.enable()` (invite biométrique), puis `POST /trusted-devices` avec `{ deviceName, platform }` | `enroll()` → `{ deviceId, secret }` (hex 32 / 64) |
| Ranger | `keystore.setItemAsync('<ns>.trustedDevice', JSON.stringify({ deviceId, secret }))` — le même `Keystore` que `createSecureSession` | rien en clair |
| Se reconnecter | `gate.confirm()` **puis** `POST /trusted-device/session` avec `{ deviceId, secret }` | `exchange()` → session + **nouveau** secret |
| Après | écrire le nouveau secret **avant** d'utiliser la session : l'ancien est mort | l'ancien reste en empreinte pour reconnaître un rejeu |
| Oublier | `POST /trusted-device/forget` avec `{ deviceId, secret }`, puis effacer la clé | `forget()`, réponse identique dans tous les cas |

La biométrie reste **locale** : le serveur ne reçoit jamais de preuve
biométrique, il reçoit le secret que le trousseau ne libère qu'après
`gate.confirm()`. Un secret perdu entre la réponse et l'écriture (application
tuée) ne se rattrape pas : l'appareil repasse par le mot de passe.

**Attention à `createSecureSession().clear()`** : à la déconnexion, il efface le
drapeau biométrique, donc `gate.confirm()` répond `false` ensuite — alors que
l'appareil de confiance existe justement pour se reconnecter **après** une
déconnexion. Garde le secret d'appareil sous sa propre clé (non effacée par
`clear()`), et fonde l'offre « se connecter avec Face ID » sur la présence de ce
secret et sur `gate.read().supported`, pas sur `enabled`.

## Tests

```bash
npm test --workspace @astratra/security
```
