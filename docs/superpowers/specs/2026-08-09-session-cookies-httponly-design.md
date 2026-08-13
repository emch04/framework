# Sessions cookie HttpOnly intégrées — Design

Date: 2026-08-09

## Contexte

`@astratra/security` (`jwtAuth.js`) sait déjà lire un token depuis `req.cookies.token`
en fallback avant le header `Authorization: Bearer`. Mais rien ne pose ce cookie :
`POST /login` dans `packages/saas-kit/src/modules/auth.js` renvoie le JWT uniquement
dans le corps JSON, et il n'existe ni cookie `HttpOnly`, ni route de logout pour
l'effacer.

## Objectif

Poser un cookie de session `HttpOnly` au login, l'effacer au logout, et protéger les
routes qui s'appuient sur ce cookie avec un middleware CSRF double-submit — tout en
restant JWT stateless (pas de session store serveur, pas de refresh token rotation).

## Décisions validées avec l'utilisateur

1. **Cookie + JSON** : le login continue de renvoyer `{ token, user }` en JSON (pour
   les clients API/mobile) ET pose un cookie `HttpOnly` (pour le web).
2. **CSRF double-submit** : ajouté comme middleware optionnel, pas monté globalement.

## Design

### 1. `packages/security/src/cookies.js` (nouveau)

- `setSessionCookie(res, token, options)` — pose `Set-Cookie` avec :
  - `HttpOnly: true` (toujours)
  - `Secure`: configurable, défaut `true` sauf si `process.env.NODE_ENV === 'development'`
  - `SameSite`: configurable, défaut `'lax'`
  - `path`: configurable, défaut `/`
  - `maxAge`: dérivé de `options.maxAgeMs` (sinon pas de `Max-Age`, cookie de session navigateur)
  - nom configurable via `options.name`, défaut `astratra_session`
- `clearSessionCookie(res, options)` — même nom/path/domain, `Max-Age: 0` /
  `Expires` dans le passé.
- Écrit à la main le header `Set-Cookie` (pas de dépendance à `cookie-parser` côté
  écriture, cohérent avec le style CommonJS existant du package).

### 2. `packages/security/src/csrf.js` (nouveau)

- `createCsrfMiddleware(options)` :
  - Génère un token aléatoire (`crypto.randomBytes(32).toString('hex')`) posé dans
    un cookie **non-HttpOnly** (`astratra_csrf` par défaut, lisible en JS côté client)
    s'il n'existe pas déjà sur la requête.
  - Pour les méthodes `POST`, `PUT`, `PATCH`, `DELETE` : exige que le header
    `x-csrf-token` (nom configurable) corresponde au cookie CSRF courant. Sinon
    `403 { success: false, message: 'Invalid CSRF token.' }`.
  - `options.skip?: (req) => boolean` pour exclure des routes (ex. webhooks
    signés autrement).
  - Laisse passer `GET`, `HEAD`, `OPTIONS` sans vérification (juste pose le cookie
    si absent).

### 3. `packages/security/src/index.js` + `index.d.ts`

- Exporter `setSessionCookie`, `clearSessionCookie`, `createCsrfMiddleware`.
- Types TS correspondants dans `index.d.ts`, cohérents avec les interfaces
  existantes (`RequestLike`, `ResponseLike`, `RequestHandler`).

### 4. `packages/saas-kit/src/modules/auth.js`

- `POST /login` : après `jwt.sign(...)`, appelle
  `setSessionCookie(res, token, cookieOptions)` avant `apiResponse(...)`. Le JSON de
  réponse reste inchangé (`{ token, user }`).
- `POST /logout` (nouvelle route, protégée par `options.authMiddleware`) : appelle
  `clearSessionCookie(res, cookieOptions)`, répond `200 { success: true }`.
- `createAuthRoutes(options)` accepte un nouvel objet optionnel `options.cookie`
  (`{ name, sameSite, secure, path, domain, maxAgeMs }`) transmis tel quel à
  `setSessionCookie`/`clearSessionCookie`. Si absent, les défauts de
  `cookies.js` s'appliquent. `maxAgeMs` par défaut dérivé de `options.jwtExpiresIn`
  si fourni (conversion simple `'1h'` → `3600000`, sinon pas de `Max-Age`).

### 5. Tests

- `packages/security/__tests__/cookies.test.js` : vérifie les attributs du header
  `Set-Cookie` posé (HttpOnly, Secure, SameSite, Max-Age, nom) et l'effacement.
- `packages/security/__tests__/csrf.test.js` : token absent → 403 ; token présent
  mais différent → 403 ; token valide → `next()` appelé ; `GET` toujours autorisé ;
  `skip` fonctionne.
- `packages/saas-kit` : test d'intégration login pose bien le cookie de session,
  logout l'efface.

## Hors scope

- Pas de session store serveur (JWT reste stateless ; révocation via
  `options.verifySession` déjà existant dans `jwtAuth.js`).
- Pas de refresh token / rotation.
- Pas de changement côté `saas-kit-ui` (le navigateur gère le cookie
  automatiquement ; rien à coder côté client pour l'auth elle-même).
- Le middleware CSRF n'est pas monté globalement par défaut — c'est à l'app hôte
  de le brancher sur les routes qui utilisent le cookie de session.
