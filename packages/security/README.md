# @astratra/security

Primitives de securite applicative pour l'authentification, l'autorisation,
le rate limiting, un WAF heuristique et WebAuthn/passkeys — generiques et
decouplees de toute base de donnees, ORM ou liste de roles fixe. Depend de
`@astratra/core`.

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
app.delete('/api/schools/:id', authorizeRoles('owner', 'admin'), handler);
```

Par defaut, le middleware limite la verification a `HS256`. Si ton application
utilise un autre algorithme, configure explicitement `algorithms`.

Si tu extrais le token depuis un cookie, configure le cookie cote application
avec `HttpOnly`, `Secure` en HTTPS et un `SameSite` adapte. Un cookie JWT peut
necessiter une protection CSRF selon tes routes, tes methodes HTTP et ton
mode d'authentification.

## Rate limiting

```js
const { createApiLimiter, createLoginLimiter, createAccountLimiter } = require('@astratra/security');

app.use(createApiLimiter());                 // 300 req / 15 min par défaut, ignore localhost
app.use('/auth', createLoginLimiter({
  onBlocked: ({ ip, req }) => alertService.notify(`Brute-force depuis ${ip}`)
}));
app.use('/auth/login', createAccountLimiter({ onBlocked: ({ identifier }) => { /* ... */ } }));
```

## WAF

```js
const { createWafMiddleware } = require('@astratra/security');
app.use(createWafMiddleware({ message: { success: false, message: 'Requête bloquée.' } }));
```

Cette couche detecte des patterns evidents SQLi/XSS/traversee de chemin/RCE
dans `req.path`, `req.query` et `req.body`. Elle ne remplace pas la
validation des entrees, les requetes parametrees, une CSP, la sanitation
adaptee au contexte, ni un WAF/reverse proxy reseau.

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
presenter WebAuthn comme production-ready, prevois une revue de securite
externe sur l'integration complete.

## Tests

```bash
npm test --workspace @astratra/security
```

21 tests, aucune vraie base de données ni cérémonie WebAuthn navigateur
requise.
