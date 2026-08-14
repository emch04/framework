# Astratra — Design @astratra/security (V0)

## Contexte

Troisième package du monorepo Astratra (voir les specs `core` et `tooling` pour le
contexte global). `@astratra/security` fournit l'authentification, l'autorisation,
le rate limiting et le WAF, extraits puis généralisés depuis une application
source.

L'application source n'exposait déjà quasiment aucun rôle en dur dans son middleware
d'autorisation (`authorizeRoles(...allowedRoles)` prend des strings), mais deux
zones sont fortement couplées au domaine et doivent être découplées :

1. `shared/middlewares/auth.middleware.js` : la vérification de `tokenVersion`
   (révocation de session) interroge une collection Mongoose choisie en dur selon
   le rôle (`student`/`parent`/`teacher` → 3 noms de collection différents).
2. Middleware de rate limiting : messages/marque produit en dur, alerte email
   envoyée à un rôle interne en dur, appel à
   un service de géolocalisation IP externe non configurable.
3. Middleware WAF : message produit en dur
   (la logique de détection de patterns, elle, est déjà générique).
4. `backend/src/modules/auth/webauthn.service.js` + `auth.webauthn.controller.js`
   (WebAuthn/passkeys) : logique de cérémonie WebAuthn déjà correcte et générique
   (résolution rpID/origin par liste blanche, TTL de challenge...), mais couplée
   à des modèles Mongoose et à une liste de rôles métier en dur.

## Principe général de découplage

Partout où l'application source a codé en dur un accès base de données ou une notion métier,
`@astratra/security` doit exposer un **adapter** : le consommateur du package
fournit des fonctions (souvent async) qui font le pont vers son propre stockage.
Le package ne connaît aucun ORM, aucun nom de modèle, aucun rôle fixe.

## Package : @astratra/security

Dépend de `@astratra/core` (workspace).

### 1. Auth JWT (`jwtAuth`)

`createAuthMiddleware(options)` → middleware Express.

- `options.secret` (requis) et `options.legacySecret` (optionnel, pour rotation
  de clé, reprend le pattern `JWT_SECRET_OLD`).
- `options.extractToken(req)` — optionnel, par défaut : cookie `token` puis
  header `Authorization: Bearer`.
- `options.verifySession(decoded)` — optionnel, callback async retournant
  `true/false`. Remplace la vérification `tokenVersion` en dur : le consommateur
  branche sa propre requête DB s'il en a besoin. Si absent, aucune vérification
  de révocation n'est faite (juste la signature JWT).
- Comportement identique à l'original sinon : 401 si token absent/invalide,
  injection de `req.user` = payload décodé.

`authorizeRoles(...allowedRoles)` — inchangé dans son principe (déjà générique),
à porter tel quel : vérifie `req.user.role` contre la liste donnée, 403 sinon.
Pas de notion de "config rôle activé/désactivé" en dur — si un projet veut ça,
il compose son propre middleware autour.

### 2. Rate limiting (`rateLimiters`)

Trois builders au lieu d'instances figées, pour rester configurables :

- `createApiLimiter(options)` — équivalent `apiLimiter` (fenêtre/max
  configurables, défaut 15 min / 300, `skip` localhost par défaut).
- `createLoginLimiter(options)` — équivalent `loginLimiter`. Au lieu d'un envoi
  d'email en dur, `options.onBlocked(context)` est un callback optionnel appelé
  avec `{ ip, req }` — le consommateur branche son propre système d'alerte s'il
  veut. Pas de géolocalisation IP intégrée (hors périmètre V0 — trop
  spécifique/consommateur d'API externe pour être une valeur par défaut d'un
  framework).
- `createAccountLimiter(options)` — équivalent `accountLimiter`, avec
  `options.keyGenerator` (défaut : `req.body.email || req.body.identifier`) et
  `options.onBlocked(context)` où `context = { identifier, ip, req }`.

Tous les messages par défaut sont neutres ("Too many requests" / générique), pas
de marque produit en dur — mais `options.message` reste surchargeable.

### 3. WAF (`wafMiddleware`)

Port direct de la logique de détection de patterns (SQLi/XSS/traversal/RCE —
déjà générique), avec `options.message` configurable au lieu d'un texte produit
en dur. `createWafMiddleware(options)`.

### 4. WebAuthn / Passkeys (`webauthn`)

Basé sur `@simplewebauthn/server`. Porte la logique de
résolution rpID/origin par liste blanche (`WEBAUTHN_ALLOWED_ORIGINS`,
`CLIENT_URL`, localhost toujours autorisé) et les TTL de challenge — cette
partie est déjà générique, à garder telle quelle.

Découplage du stockage : `createWebauthnService(store, options)` où `store` est
un objet de fonctions fournies par le consommateur :
- `store.getCredentialsForUser(userId)`
- `store.saveCredential(userId, credential)`
- `store.getCredentialById(credentialId)`
- `store.updateCredentialCounter(credentialId, counter)`
- `store.saveChallenge(userId, challenge, purpose)`
- `store.consumeChallenge(userId, purpose)` (retourne et supprime)

Pas de notion de rôles autorisés à faire du WebAuthn codée en dur : c'est au
consommateur de décider qui a le droit d'enregistrer une clé (via ses propres
routes/guards, en composant avec `authorizeRoles`).

Codes de récupération (`recoveryCodes`) : générateur + vérificateur génériques
(hash + comparaison), stockage délégué au `store` de la même façon
(`store.saveRecoveryCodes`, `store.consumeRecoveryCode`).

## Tests

Tests unitaires Jest pour chaque module :
- `jwtAuth` : token valide/absent/expiré/mauvaise signature, rotation de secret,
  `verifySession` appelé ou non selon présence.
- `rateLimiters` : construction des limiteurs, `onBlocked` appelé dans les bons
  cas (mock d'express-rate-limit ou test du `handler` directement).
- `waf` : chaque catégorie de pattern (SQLi, XSS, traversal) bloquée, requête
  normale laissée passer.
- `webauthn` : cérémonies d'enregistrement/authentification avec un `store` mock
  en mémoire (pas de vraie DB, pas de vrai navigateur — mocker
  `@simplewebauthn/server` si nécessaire pour isoler la logique d'orchestration).

## Hors périmètre V0

- Géolocalisation IP des tentatives de brute-force (spécifique, pas une valeur
  par défaut de framework).
- `dlp.js` / scan de secrets : déjà couvert par `@astratra/tooling`
  (`audit:secrets`), pas dupliqué ici.
- Chiffrement générique : reporté à un futur spec
  si un besoin concret apparaît — pas listé dans les 5 sous-modules ci-dessus.
