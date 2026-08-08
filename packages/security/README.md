# @astratra/security

Authentification, autorisation, rate limiting, WAF et WebAuthn/passkeys —
générique et découplé de toute base de données, ORM ou liste de rôles fixe.
Dépend de `@astratra/core`.

Partout où un vrai projet a besoin de persistance (révocation de session,
stockage de credentials WebAuthn, alerte de brute-force), c'est un
callback/adapter injecté, jamais un appel base de données codé en dur.

## Auth JWT + RBAC

```js
const { createAuthMiddleware, authorizeRoles } = require('@astratra/security');

const authMiddleware = createAuthMiddleware({
  secret: process.env.JWT_SECRET,
  legacySecret: process.env.JWT_SECRET_OLD,       // optionnel, pour la rotation de clé
  verifySession: async (decoded) => sessionStore.isActive(decoded)  // vérification de révocation optionnelle
});

app.use('/api', authMiddleware);
app.delete('/api/schools/:id', authorizeRoles('owner', 'admin'), handler);
```

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

Bloque les patterns SQLi/XSS/traversée de chemin/RCE courants dans
`req.path`, `req.query` et `req.body`.

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
— ce contrôle d'accès reste à la charge de l'app consommatrice.

## Tests

```bash
npm test --workspace @astratra/security
```

21 tests, aucune vraie base de données ni cérémonie WebAuthn navigateur
requise.
