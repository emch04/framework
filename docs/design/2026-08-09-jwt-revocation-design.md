# Révocation de session JWT — Design

Date: 2026-08-09

## Contexte

Le hook `options.verifySession(decoded)` existe déjà dans `createAuthMiddleware`
(`packages/security/src/jwtAuth.js`) et est câblé dans `createSaasApp`
(`packages/saas-kit/src/app.js:98`), mais rien ne l'implémente par défaut. Résultat
vérifié : `/auth/logout` efface le cookie de session mais le JWT reste valide
jusqu'à expiration — un token volé avant logout continue de fonctionner.

## Objectif

Faire en sorte que `POST /auth/logout` invalide réellement le JWT immédiatement,
sans configuration requise (store en mémoire par défaut), avec un point
d'extension pour brancher un store externe (Redis, etc.) en production
multi-instance.

## Décisions validées avec l'utilisateur

1. **Actif par défaut** : `createSaasApp` fournit un `revocationStore` en mémoire
   par défaut (même pattern que `usersStore`/`settingsStore`). Remplaçable via
   `options.revocationStore`.
2. Corrélé au fix mineur déjà identifié : `maxAgeMs` du cookie doit être dérivé
   même quand `jwtExpiresIn` n'est pas fourni explicitly (défaut `'1h'`), pour
   rester cohérent avec l'expiration réelle du token.

## Design

### 1. JWT : ajout d'un identifiant unique par token (`jti`)

- `packages/saas-kit/src/modules/auth.js`, route `POST /login` : génère un `jti`
  (`crypto.randomUUID()`) et l'inclut dans le payload signé (`jwt.sign({ ...publicUser, jti }, ...)`).
  Sans `jti`, impossible de révoquer un token précis sans blacklister le user entier.

### 2. `packages/security/src/revocation.js` (nouveau)

- `createMemoryRevocationStore()` — implémentation de référence :
  - `revoke(jti, expiresAt)` : ajoute `jti` à un `Map` avec la date d'expiration
    du JWT (pour purge).
  - `isRevoked(jti)` : `true` si présent et non expiré (purge lazy si expiré).
  - `revokeAllForUser(userId, expiresAt)` : optionnel, pour un futur "déconnecter
    partout" — stocke `userId` avec un timestamp `revokedBefore`; hors scope
    d'implémentation immédiate (juste l'interface, pas branché sur une route).
- Purge : à chaque `isRevoked`/`revoke`, retire paresseusement les entrées dont
  `expiresAt < Date.now()` (pas de `setInterval`, pour rester simple et
  testable).
- Interface documentée dans `index.d.ts` (`RevocationStore`) pour permettre une
  implémentation Redis/DB par un consommateur, sans dépendance ajoutée au
  package `security`.

### 3. `packages/security/src/jwtAuth.js`

- `createAuthMiddleware(options)` : si `options.revocationStore` est fourni,
  construit automatiquement le `verifySession` par défaut :
  `async (decoded) => !(await options.revocationStore.isRevoked(decoded.jti))`.
  Si le consommateur passe **aussi** `options.verifySession` explicitement, la
  fonction fournie est utilisée telle quelle (le store de révocation ne
  s'applique alors que si son propre `verifySession` l'utilise) — pas de
  double logique cachée.

### 4. `packages/saas-kit/src/app.js`

- `normalizeOptions` : `revocationStore = options.revocationStore || createMemoryRevocationStore()`.
- `createAuthMiddleware({ ..., revocationStore: normalized.revocationStore })`.
- `createAuthRoutes({ ..., revocationStore: normalized.revocationStore })` pour
  que `/auth/logout` puisse appeler `revoke`.

### 5. `packages/saas-kit/src/modules/auth.js`

- `POST /logout` : après avoir vérifié `req.user` (posé par `authMiddleware`),
  appelle `options.revocationStore.revoke(req.user.jti, req.user.exp * 1000)`
  avant `clearSessionCookie`. Si `req.user.jti` est absent (token émis avant ce
  changement, rétrocompatibilité), skip silencieusement — le logout efface
  quand même le cookie.
- Fix connexe : `cookieOptionsFrom` doit dériver `maxAgeMs` avec un fallback
  `'1h'` quand `options.jwtExpiresIn` n'est pas fourni, pour matcher exactement
  la durée de vie réelle du JWT signé par `/login`.

### 6. Tests

- `packages/security/__tests__/revocation.test.js` : `revoke` puis `isRevoked`
  → `true` ; jamais révoqué → `false` ; purge d'une entrée expirée.
- `packages/security/__tests__/jwtAuth.test.js` (extension) : middleware avec
  `revocationStore` rejette un token dont le `jti` a été révoqué, meme si le
  JWT est cryptographiquement valide et non expiré.
- `packages/saas-kit/__tests__/saas-kit.test.js` (extension) : test de mutation
  bout-en-bout — login → logout → rejeu du **même token** (cookie ou Bearer) sur
  une route protégée → doit être rejeté (401), alors qu'avant ce changement il
  aurait été accepté jusqu'à expiration naturelle.

## Hors scope

- Pas de store Redis fourni (juste l'interface `RevocationStore` + doc).
- Pas de route "déconnecter tous mes appareils" (`revokeAllForUser` reste une
  méthode d'interface non branchée sur une route HTTP).
- Pas de purge active par timer (`setInterval`) — purge paresseuse uniquement,
  suffisante pour un store en mémoire de dev/single-instance.
