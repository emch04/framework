# Logout everywhere ("déconnecter tous mes appareils") — Design

Date: 2026-08-09

## Contexte

`RevocationStore.revokeAllForUser(userId, expiresAt)` existe déjà dans l'interface
(`packages/security/src/revocation.js`) mais n'est branché sur rien : la méthode
écrit dans une Map interne (`revokedUsers`) que `isRevoked` ne consulte jamais.
Aucune route ne l'appelle. Point volontairement laissé hors scope lors de
l'implémentation de la révocation par token.

## Objectif

Permettre à un utilisateur d'invalider tous ses JWT actifs (tous appareils/onglets)
en un appel, pas seulement le token courant (`/auth/logout` existant).

## Design

### 1. `packages/security/src/revocation.js`

- `revokeAllForUser(userId, revokedBeforeMs = Date.now())` : enregistre dans
  `revokedUsers` le seuil `revokedBeforeMs` — tout token de cet utilisateur émis
  (`iat`) avant ce seuil est désormais invalide.
- Nouvelle méthode `isRevokedForUser(userId, issuedAtSeconds)` : retourne `true`
  si `issuedAtSeconds * 1000 <= revokedBeforeMs` stocké pour `userId`, sinon
  `false` (y compris si `userId` n'a jamais fait de logout-all).
- Pas de purge active sur `revokedUsers` : une entrée par utilisateur ayant déjà
  fait un logout-all, borné par le nombre d'utilisateurs — pas un risque de fuite
  mémoire comme le serait une entrée par token.

### 2. `packages/security/src/jwtAuth.js`

- Le `verifySession` dérivé par défaut de `options.revocationStore` vérifie
  **les deux** : `isRevoked(decoded.jti)` (token précis) ET, si la méthode existe
  et que `decoded.id`/`decoded.iat` sont présents, `isRevokedForUser(decoded.id, decoded.iat)`.
  Rejette (retourne `false`) si l'une des deux dit "révoqué".
- Rétrocompatible : si le store ne fournit pas `isRevokedForUser`, seule la
  vérification par `jti` s'applique (comportement actuel inchangé).

### 3. `packages/saas-kit/src/modules/auth.js`

- Nouvelle route `POST /auth/logout-all`, protégée par `options.authMiddleware`
  puis `csrfMiddleware` (même traitement que `/auth/logout`).
- Appelle `options.revocationStore.revokeAllForUser(req.user.id, Date.now())` si
  le store et `req.user.id` existent, puis `clearSessionCookie` (efface aussi la
  session du navigateur courant), répond `{ success: true }`.

### 4. Types (`index.d.ts` + `typecheck.ts`)

- Ajouter `isRevokedForUser(userId: string, issuedAtSeconds: number): Awaitable<boolean>`
  (optionnel) à l'interface `RevocationStore`.
- Exercer la nouvelle méthode dans `packages/security/typecheck.ts`.

### 5. Tests

- `revocation.test.js` : token émis avant un `revokeAllForUser` → `isRevokedForUser`
  `true` ; token émis après → `false` ; utilisateur jamais révoqué → `false`.
- `jwtAuth.test.js` : middleware avec `revocationStore` rejette un decoded dont
  `iat` précède un `revokeAllForUser` pour son `id`, même si `jti` n'est pas dans
  la liste des tokens individuellement révoqués.
- `saas-kit.test.js`, test de mutation : login deux fois (2 tokens distincts pour
  le même user, simulant 2 appareils) → `POST /auth/logout-all` avec le token A →
  les DEUX tokens A et B doivent être rejetés ensuite → un nouveau login après
  coup (token C) doit fonctionner normalement.

## Hors scope

- Pas de purge active des entrées `revokedUsers` (bornées par nb d'utilisateurs).
- Pas d'UI/liste des sessions actives par appareil.
