# Astratra — Connexion Google/Apple et inscription — Plan de réalisation

> **Pour l'exécutant :** tâches dans l'ordre, cases `- [ ]` à cocher. Aucun commit par l'agent : chaque tâche finit par un point d'arrêt où Kongo relit et committe. La publication npm est faite par Kongo.

**But :** qu'une app Astratra ouvre une session après une connexion Google ou Apple, et accepte des inscriptions par e-mail filtrées par l'application — avec des jetons fabriqués au même endroit que ceux de `/auth/login`.

**Architecture :** `@astratra/security` gagne un vérificateur de jeton d'identité (JWKS, sans dépendance nouvelle : `crypto.createPublicKey` + `jsonwebtoken`) et ses deux préréglages Google et Apple. `@astratra/saas-kit` extrait l'émission de session de `/auth/login` dans une fonction interne unique `issueSession`, puis l'utilise pour deux routes optionnelles : `POST /auth/external/:provider` et `POST /auth/register`. Rien ne change pour une app qui ne passe pas les nouvelles options.

**Stack :** Node ≥ 20, CommonJS, `jsonwebtoken`, jest (security), `node:test` (saas-kit).

**Demandé par :** Tertius (`~/JW.AI/docs/specs/2026-09-23-jwai-architecture.md`, section Sécurité).

## Contraintes globales

- Aucune dépendance ajoutée.
- Options absentes = comportement strictement identique à aujourd'hui (routes non montées).
- Le mot de passe haché est stocké dans le champ `password` de l'utilisateur, comme le fait déjà `/auth/reset-password`.
- Un refus ne révèle jamais si un compte existe (même message pour « pas invité » et « compte absent »).
- Versions : `@astratra/security` 1.11.0 → **1.12.0**, `@astratra/saas-kit` 1.6.0 → **1.7.0** ; plancher de `security` relevé dans `saas-kit`.

---

### Tâche 1 : Vérificateur de jeton d'identité (`@astratra/security`)

**Fichiers :**
- Créer : `packages/security/src/idTokens.js`, `packages/security/__tests__/idTokens.test.js`
- Modifier : `packages/security/src/index.js` (ajout `...require('./idTokens')`), `packages/security/src/index.d.ts`

**Interfaces :**
- Produit :
  - `createIdTokenVerifier({ jwksUrl, issuers, audiences, fetch?, now?, cacheMs?, minRefreshMs? }) → (idToken: string) => Promise<IdTokenProfile>`
  - `createGoogleIdTokenVerifier({ audiences, ...options })`, `createAppleIdTokenVerifier({ audiences, ...options })`
  - `IdTokenProfile = { subject: string, email: string | null, emailVerified: boolean, claims: object }`
  - Toute erreur (signature, émetteur, audience, expiration, clé inconnue) rejette la promesse.

- [ ] **Étape 1 : Test qui échoue — `__tests__/idTokens.test.js`**

```js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  createIdTokenVerifier,
  createGoogleIdTokenVerifier,
  createAppleIdTokenVerifier
} = require('../src');

const ISSUER = 'https://issuer.test';
const AUDIENCE = 'com.example.app';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

function fakeFetch(keys = [jwk]) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ keys }) };
  };
  return { fetch, calls };
}

function sign(payload = {}, options = {}) {
  return jwt.sign(
    { sub: 'user-123', email: 'Kongo@Example.test', email_verified: true, ...payload },
    privateKey,
    { algorithm: 'RS256', keyid: 'k1', issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m', ...options }
  );
}

function verifierWith(fetch, extra = {}) {
  return createIdTokenVerifier({ jwksUrl: 'https://keys.test', issuers: [ISSUER], audiences: [AUDIENCE], fetch, ...extra });
}

describe('createIdTokenVerifier', () => {
  it('returns the profile of a valid token, email lower-cased', async () => {
    const { fetch } = fakeFetch();
    const profile = await verifierWith(fetch)(sign());
    expect(profile).toMatchObject({ subject: 'user-123', email: 'kongo@example.test', emailVerified: true });
  });

  it('accepts email_verified sent as the string "true" (Apple)', async () => {
    const { fetch } = fakeFetch();
    const profile = await verifierWith(fetch)(sign({ email_verified: 'true' }));
    expect(profile.emailVerified).toBe(true);
  });

  it('rejects a wrong audience, a wrong issuer and an expired token', async () => {
    const { fetch } = fakeFetch();
    const verify = verifierWith(fetch);
    await expect(verify(sign({}, { audience: 'someone.else' }))).rejects.toThrow();
    await expect(verify(sign({}, { issuer: 'https://evil.test' }))).rejects.toThrow();
    await expect(verify(sign({}, { expiresIn: -10 }))).rejects.toThrow();
  });

  it('rejects a token signed by another key under the same kid', async () => {
    const { fetch } = fakeFetch();
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = jwt.sign({ sub: 'x' }, other, { algorithm: 'RS256', keyid: 'k1', issuer: ISSUER, audience: AUDIENCE });
    await expect(verifierWith(fetch)(forged)).rejects.toThrow();
  });

  it('caches the key set, and refetches for an unknown kid once minRefreshMs has passed', async () => {
    let clock = 1_000_000;
    const { fetch, calls } = fakeFetch();
    const verify = verifierWith(fetch, { now: () => clock });
    await verify(sign());
    await verify(sign());
    expect(calls).toHaveLength(1);

    const unknown = jwt.sign({ sub: 'x' }, privateKey, { algorithm: 'RS256', keyid: 'k2', issuer: ISSUER, audience: AUDIENCE });
    await expect(verify(unknown)).rejects.toThrow('unknown key');
    expect(calls).toHaveLength(1);

    clock += 61_000;
    await expect(verify(unknown)).rejects.toThrow('unknown key');
    expect(calls).toHaveLength(2);
    await expect(verify(unknown)).rejects.toThrow('unknown key');
    expect(calls).toHaveLength(2);
  });

  it('reloads the whole key set once cacheMs has passed', async () => {
    let clock = 1_000_000;
    const { fetch, calls } = fakeFetch();
    const verify = verifierWith(fetch, { now: () => clock });
    await verify(sign());
    clock += 60 * 60 * 1000;
    await verify(sign());
    expect(calls).toHaveLength(2);
  });

  it('refuses to be built without jwksUrl, issuers and audiences', () => {
    expect(() => createIdTokenVerifier({ jwksUrl: 'x', issuers: [], audiences: ['a'] })).toThrow();
  });

  it('Google and Apple presets point at their real key sets', async () => {
    const google = fakeFetch();
    await expect(createGoogleIdTokenVerifier({ audiences: [AUDIENCE], fetch: google.fetch })(sign())).rejects.toThrow();
    expect(google.calls[0]).toBe('https://www.googleapis.com/oauth2/v3/certs');

    const apple = fakeFetch();
    await expect(createAppleIdTokenVerifier({ audiences: [AUDIENCE], fetch: apple.fetch })(sign())).rejects.toThrow();
    expect(apple.calls[0]).toBe('https://appleid.apple.com/auth/keys');
  });
});
```

(Les préréglages rejettent le jeton de test parce que son émetteur n'est ni Google ni Apple : ce qu'on vérifie, c'est l'URL des clés.)

- [ ] **Étape 2 : Lancer, vérifier l'échec**

Run : `npm test --workspace @astratra/security -- idTokens`
Attendu : FAIL, `createIdTokenVerifier is not a function`.

- [ ] **Étape 3 : Écrire `src/idTokens.js`**

```js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const DEFAULT_CACHE_MS = 60 * 60 * 1000;
const DEFAULT_MIN_REFRESH_MS = 60 * 1000;

/**
 * Verifies an OpenID Connect ID token (Google, Apple, any provider that
 * publishes a JWKS) without a JOSE dependency: Node turns each JWK into a
 * KeyObject, jsonwebtoken checks signature, issuer, audience and expiry.
 *
 * An unknown `kid` triggers ONE refetch — providers rotate keys — but never
 * more than once per `minRefreshMs`, or a stream of forged tokens would turn
 * this server into a proxy hammering the provider.
 */
function createIdTokenVerifier(options = {}) {
  const {
    jwksUrl,
    issuers,
    audiences,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    cacheMs = DEFAULT_CACHE_MS,
    minRefreshMs = DEFAULT_MIN_REFRESH_MS
  } = options;

  if (!jwksUrl || !Array.isArray(issuers) || issuers.length === 0 || !Array.isArray(audiences) || audiences.length === 0) {
    throw new Error('createIdTokenVerifier requires jwksUrl, issuers and audiences.');
  }

  let keys = new Map();
  let fetchedAt = -Infinity;

  async function refresh() {
    const response = await fetchImpl(jwksUrl);
    if (!response.ok) throw new Error(`Key set request failed with status ${response.status}.`);
    const body = await response.json();
    const next = new Map();
    for (const jwk of body.keys || []) {
      if (jwk.kid && jwk.kty === 'RSA') {
        next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
      }
    }
    keys = next;
    fetchedAt = now();
  }

  async function keyFor(kid) {
    if (now() - fetchedAt >= cacheMs) {
      await refresh();
    } else if (!keys.has(kid) && now() - fetchedAt >= minRefreshMs) {
      await refresh();
    }
    return keys.get(kid) || null;
  }

  return async function verifyIdToken(idToken) {
    const decoded = jwt.decode(idToken, { complete: true });
    const kid = decoded && decoded.header && decoded.header.kid;
    const key = kid ? await keyFor(kid) : null;
    if (!key) throw new Error('ID token signed by an unknown key.');

    const claims = jwt.verify(idToken, key, {
      algorithms: ['RS256'],
      issuer: issuers,
      audience: audiences
    });

    return {
      subject: String(claims.sub),
      email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      claims
    };
  };
}

function createGoogleIdTokenVerifier({ audiences, ...options } = {}) {
  return createIdTokenVerifier({
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    audiences,
    ...options
  });
}

function createAppleIdTokenVerifier({ audiences, ...options } = {}) {
  return createIdTokenVerifier({
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    issuers: ['https://appleid.apple.com'],
    audiences,
    ...options
  });
}

module.exports = {
  createIdTokenVerifier,
  createGoogleIdTokenVerifier,
  createAppleIdTokenVerifier
};
```

`now` ne sert qu'au cache des clés ; l'expiration du jeton est jugée sur l'heure réelle par `jsonwebtoken`.

- [ ] **Étape 4 : Types dans `src/index.d.ts`** (après le bloc des jetons de renouvellement)

```ts
/* ─────────────────────── ID tokens (Google, Apple) ─────────────────────── */

export interface IdTokenProfile {
  subject: string;
  /** Lower-cased. Null when the provider did not share it. */
  email: string | null;
  emailVerified: boolean;
  claims: Record<string, unknown>;
}

export interface IdTokenVerifierOptions {
  jwksUrl: string;
  issuers: string[];
  audiences: string[];
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
  now?: () => number;
  /** How long a fetched key set is trusted. Default 1 hour. */
  cacheMs?: number;
  /** Floor between two refetches caused by an unknown kid. Default 1 minute. */
  minRefreshMs?: number;
}

export type IdTokenVerifier = (idToken: string) => Promise<IdTokenProfile>;

export function createIdTokenVerifier(options: IdTokenVerifierOptions): IdTokenVerifier;
export function createGoogleIdTokenVerifier(options: Omit<IdTokenVerifierOptions, 'jwksUrl' | 'issuers'>): IdTokenVerifier;
export function createAppleIdTokenVerifier(options: Omit<IdTokenVerifierOptions, 'jwksUrl' | 'issuers'>): IdTokenVerifier;
```

- [ ] **Étape 5 : Lancer, vérifier le succès**

Run : `npm test --workspace @astratra/security`
Attendu : toute la suite PASS.

- [ ] **Étape 6 : Point d'arrêt** — Kongo committe. Message proposé : `feat(security): vérification des jetons d'identité Google et Apple`

---

### Tâche 2 : Émission de session unique et connexion externe (`@astratra/saas-kit`)

**Fichiers :**
- Modifier : `packages/saas-kit/src/modules/auth.js`, `packages/saas-kit/src/index.d.ts`
- Créer : `packages/saas-kit/__tests__/helpers/request.js` (fonction `request` déplacée depuis `sessions.test.js`, qui l'importe désormais), `packages/saas-kit/__tests__/externalAuth.test.js`

**Interfaces :**
- Consomme : un `IdTokenVerifier` (tâche 1) ou toute fonction de même forme.
- Produit : option `externalSignIn = { providers: Record<string, (idToken: string) => Promise<IdTokenProfile>>, resolveUser(input: { provider: string, profile: IdTokenProfile }): Promise<SaasUser | null> }` ; route `POST /auth/external/:provider` corps `{ idToken }` → même réponse que `/auth/login` (`{ token, user, refreshToken? }`). Codes : fournisseur inconnu 404, jeton invalide 401, `resolveUser` → `null` 403 `Sign-in not allowed.`

- [ ] **Étape 1 : Déplacer `request`**

Couper la fonction `request` de `__tests__/sessions.test.js` vers `__tests__/helpers/request.js` (`module.exports = { request };`), puis dans `sessions.test.js` : `const { request } = require('./helpers/request');`.

Run : `npm test --workspace @astratra/saas-kit`
Attendu : PASS, rien n'a changé.

- [ ] **Étape 2 : Test qui échoue — `__tests__/externalAuth.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSaasApp, createMemoryUsersStore } = require('../src');
const { request } = require('./helpers/request');

const TEST_SECRET = 'saas-kit-test-secret';

function appWith(options = {}) {
  return createSaasApp({
    jwtSecret: TEST_SECRET,
    notify: async () => ({ queued: true }),
    verifyPassword: async () => false,
    loginRateLimit: { max: 100 },
    apiRateLimit: { max: 100 },
    ...options
  });
}

const google = async (idToken) => {
  if (idToken !== 'good-token') throw new Error('bad token');
  return { subject: 'g-1', email: 'kongo@example.test', emailVerified: true, claims: {} };
};

test('the external route does not exist without externalSignIn', async () => {
  const response = await request(appWith(), 'POST', '/auth/external/google', { body: { idToken: 'good-token' } });
  assert.equal(response.status, 404);
});

test('a verified external identity resolved to a user opens a session like login does', async () => {
  const usersStore = createMemoryUsersStore({ users: [] });
  const seen = [];
  const app = appWith({
    usersStore,
    refreshTokens: { enabled: true },
    externalSignIn: {
      providers: { google },
      resolveUser: async (input) => {
        seen.push(input);
        return usersStore.create({ email: input.profile.email, role: 'member' });
      }
    }
  });

  const response = await request(app, 'POST', '/auth/external/google', { body: { idToken: 'good-token' } });
  assert.equal(response.status, 200);
  assert.ok(response.body.data.token);
  assert.ok(response.body.data.refreshToken);
  assert.equal(response.body.data.user.email, 'kongo@example.test');
  assert.equal(seen[0].provider, 'google');
  assert.equal(seen[0].profile.subject, 'g-1');

  const me = await request(app, 'GET', '/auth/me', { token: response.body.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.email, 'kongo@example.test');

  const renewed = await request(app, 'POST', '/auth/refresh', { body: { refreshToken: response.body.data.refreshToken } });
  assert.equal(renewed.status, 200);
});

test('unknown provider 404, invalid token 401, refused identity 403', async () => {
  const app = appWith({
    externalSignIn: { providers: { google }, resolveUser: async () => null }
  });

  assert.equal((await request(app, 'POST', '/auth/external/facebook', { body: { idToken: 'good-token' } })).status, 404);
  assert.equal((await request(app, 'POST', '/auth/external/google', { body: { idToken: 'forged' } })).status, 401);
  assert.equal((await request(app, 'POST', '/auth/external/google', { body: {} })).status, 400);

  const refused = await request(app, 'POST', '/auth/external/google', { body: { idToken: 'good-token' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.message, 'Sign-in not allowed.');
});

test('createSaasApp refuses externalSignIn without resolveUser', () => {
  assert.throws(() => appWith({ externalSignIn: { providers: { google } } }), /resolveUser/);
});
```

- [ ] **Étape 3 : Lancer, vérifier l'échec**

Run : `npm test --workspace @astratra/saas-kit`
Attendu : FAIL sur les nouveaux tests (404 là où 200 est attendu, pas d'exception au montage).

- [ ] **Étape 4 : Extraire `issueSession` dans `src/modules/auth.js`**

Juste après `signAccessToken`, ajouter :

```js
  /**
   * Every way in — password, Google, Apple, a fresh registration — ends here,
   * so the session they open is the same session: same token, same refresh
   * chain, same cookie.
   */
  const issueSession = async (res, user, message) => {
    const publicUser = pickPublicUser(user, publicUserFields);

    /* A refresh token is issued only when the product asked for one. The web
       client rides on an HttpOnly cookie and needs none; handing it a
       long-lived credential it never uses only widens the target. */
    let refresh = null;
    if (refreshTokenService) {
      refresh = await refreshTokenService.issue({ userId: String(user.id) });
    }

    /* The family id travels in the access token so that signing out can revoke
       the refresh chain without the client having to hand it back. */
    const token = signAccessToken(publicUser, refresh ? { rfid: refresh.familyId } : {});
    setSessionCookie(res, token, cookieOptions);

    return apiResponse(res, 200, message, {
      token,
      user: publicUser,
      ...(refresh ? { refreshToken: refresh.token } : {})
    });
  };
```

Et réduire le corps de `/login` à :

```js
  router.post('/login', validateMiddleware(loginValidation), asyncHandler(async (req, res) => {
    const user = await usersStore.findByEmail(req.body.email);
    const valid = user ? await verifyPassword(user, req.body.password) : false;
    if (!user || !valid) {
      throw new AppError('Invalid credentials.', 401);
    }
    return issueSession(res, user, 'Login successful');
  }));
```

Run : `npm test --workspace @astratra/saas-kit` — les tests existants passent toujours (seuls les nouveaux échouent).

- [ ] **Étape 5 : Route externe, après `/login`**

```js
  if (options.externalSignIn) {
    const { providers = {}, resolveUser } = options.externalSignIn;

    router.post('/external/:provider', validateMiddleware([
      body('idToken').isString().notEmpty().withMessage('idToken is required')
    ]), asyncHandler(async (req, res) => {
      const verify = Object.prototype.hasOwnProperty.call(providers, req.params.provider)
        ? providers[req.params.provider]
        : null;
      if (!verify) throw new AppError('Unknown sign-in provider.', 404);

      let profile;
      try {
        profile = await verify(req.body.idToken);
      } catch (_error) {
        throw new AppError('Sign-in could not be verified.', 401);
      }

      const user = await resolveUser({ provider: req.params.provider, profile });
      if (!user) throw new AppError('Sign-in not allowed.', 403);

      return issueSession(res, user, 'Login successful');
    }));
  }
```

- [ ] **Étape 6 : Contrôle au montage dans `src/app.js`, fonction `normalizeOptions`** (à côté du contrôle `passwordReset`)

```js
  if (options.externalSignIn && typeof options.externalSignIn.resolveUser !== 'function') {
    throw new Error('createSaasApp requires options.externalSignIn.resolveUser.');
  }
```

- [ ] **Étape 7 : Types dans `src/index.d.ts`** (dans `CreateSaasAppOptions`, après `hashPassword`)

```ts
  /**
   * Sign-in through an identity provider (Google, Apple…). Each provider is a
   * verifier — typically createGoogleIdTokenVerifier from @astratra/security.
   * resolveUser decides who this identity is here: find, link, create, or
   * null to refuse. Mounts POST /auth/external/:provider.
   */
  externalSignIn?: {
    providers: Record<string, (idToken: string) => Promise<IdTokenProfile>>;
    resolveUser(input: { provider: string; profile: IdTokenProfile }): Promise<SaasUser | null>;
  };
```

et ajouter `IdTokenProfile` à la liste des types importés de `@astratra/security` en tête du fichier.

- [ ] **Étape 8 : Lancer, vérifier le succès**

Run : `npm test --workspace @astratra/saas-kit`
Attendu : toute la suite PASS.

- [ ] **Étape 9 : Point d'arrêt** — Kongo committe. Message proposé : `feat(saas-kit): connexion par fournisseur d'identité`

---

### Tâche 3 : Inscription filtrée (`@astratra/saas-kit`)

**Fichiers :**
- Modifier : `packages/saas-kit/src/modules/auth.js`, `packages/saas-kit/src/app.js`, `packages/saas-kit/src/index.d.ts`
- Créer : `packages/saas-kit/__tests__/registration.test.js`

**Interfaces :**
- Consomme : `issueSession` (tâche 2), `hashPassword` (option existante).
- Produit : option `registration = { allow(email: string): Promise<boolean>, role?: string, isValidPassword?(password: string): boolean }` ; route `POST /auth/register` corps `{ email, password }` → session ouverte (réponse de `/auth/login`). Refus d'`allow` **et** adresse déjà prise → même réponse 403 `Registration not allowed.` Mot de passe refusé par `isValidPassword` → 400 `Password does not meet the requirements.` Par défaut `isValidPassword` exige 12 caractères ; l'app passe `createPasswordRules(...).isValid` de `@astratra/client`, le même objet que son écran utilise. L'e-mail est enregistré en minuscules, le hash dans `password`.

- [ ] **Étape 1 : Test qui échoue — `__tests__/registration.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSaasApp, createMemoryUsersStore } = require('../src');
const { request } = require('./helpers/request');

const hashPassword = async (password) => `hashed:${password}`;

function appWith(options = {}) {
  return createSaasApp({
    jwtSecret: 'saas-kit-test-secret',
    notify: async () => ({ queued: true }),
    verifyPassword: async (user, password) => user.password === `hashed:${password}`,
    loginRateLimit: { max: 100 },
    apiRateLimit: { max: 100 },
    ...options
  });
}

test('the register route does not exist without registration', async () => {
  const response = await request(appWith(), 'POST', '/auth/register', { body: { email: 'a@b.test', password: 'long enough pass' } });
  assert.equal(response.status, 404);
});

test('an allowed address registers, is signed in, and can log in afterwards', async () => {
  const usersStore = createMemoryUsersStore({ users: [] });
  const app = appWith({
    usersStore,
    hashPassword,
    registration: { allow: async (email) => email === 'friend@example.test', role: 'member' }
  });

  const response = await request(app, 'POST', '/auth/register', { body: { email: 'Friend@Example.test', password: 'a long password' } });
  // Default rule: 12 characters, nothing else.
  assert.equal(response.status, 200);
  assert.ok(response.body.data.token);
  assert.equal(response.body.data.user.email, 'friend@example.test');

  const stored = await usersStore.findByEmail('friend@example.test');
  assert.equal(stored.password, 'hashed:a long password');
  assert.equal(stored.role, 'member');

  const login = await request(app, 'POST', '/auth/login', { body: { email: 'friend@example.test', password: 'a long password' } });
  assert.equal(login.status, 200);
});

test('not allowed and already taken answer the same 403; a refused password 400', async () => {
  const usersStore = createMemoryUsersStore({ users: [] });
  await usersStore.create({ email: 'taken@example.test', role: 'member', password: 'hashed:x' });
  const app = appWith({
    usersStore,
    hashPassword,
    registration: {
      allow: async (email) => email !== 'stranger@example.test',
      isValidPassword: (password) => password.length >= 12 && /\d/.test(password)
    }
  });

  const stranger = await request(app, 'POST', '/auth/register', { body: { email: 'stranger@example.test', password: 'a long password' } });
  const taken = await request(app, 'POST', '/auth/register', { body: { email: 'taken@example.test', password: 'a long password' } });
  assert.equal(stranger.status, 403);
  assert.equal(taken.status, 403);
  assert.equal(stranger.body.message, taken.body.message);

  const short = await request(app, 'POST', '/auth/register', { body: { email: 'new@example.test', password: 'short' } });
  assert.equal(short.status, 400);
  const noDigit = await request(app, 'POST', '/auth/register', { body: { email: 'new@example.test', password: 'long but no digit' } });
  assert.equal(noDigit.status, 400);
  assert.equal(noDigit.body.message, 'Password does not meet the requirements.');
});

test('createSaasApp refuses registration without allow or hashPassword', () => {
  assert.throws(() => appWith({ registration: { allow: async () => true } }), /hashPassword/);
  assert.throws(() => appWith({ hashPassword, registration: {} }), /allow/);
});
```

- [ ] **Étape 2 : Lancer, vérifier l'échec**

Run : `npm test --workspace @astratra/saas-kit`
Attendu : FAIL sur `registration.test.js`.

- [ ] **Étape 3 : Route dans `src/modules/auth.js`, après la route externe**

```js
  if (options.registration) {
    const {
      allow,
      role = 'member',
      /* The app passes the SAME rule object its sign-up screen checks live
         (createPasswordRules from @astratra/client): two copies of a password
         rule drift, and the screen accepts what the server refuses. */
      isValidPassword = (password) => password.length >= 12
    } = options.registration;

    router.post('/register', validateMiddleware([
      body('email').isEmail().withMessage('email must be a valid email address'),
      body('password').isString().notEmpty().withMessage('password is required')
    ]), asyncHandler(async (req, res) => {
      if (!isValidPassword(req.body.password)) {
        throw new AppError('Password does not meet the requirements.', 400);
      }

      const email = String(req.body.email).trim().toLowerCase();

      /* Same answer for "not invited" and "already has an account": this
         screen must not tell a stranger which addresses exist here. */
      const allowed = await allow(email);
      const existing = allowed ? await usersStore.findByEmail(email) : null;
      if (!allowed || existing) throw new AppError('Registration not allowed.', 403);

      const user = await usersStore.create({ email, role, password: await hashPassword(req.body.password) });
      return issueSession(res, user, 'Registration successful');
    }));
  }
```

- [ ] **Étape 4 : Contrôles au montage dans `normalizeOptions` (`src/app.js`)**

```js
  if (options.registration) {
    if (typeof options.registration.allow !== 'function') {
      throw new Error('createSaasApp requires options.registration.allow.');
    }
    if (typeof options.hashPassword !== 'function') {
      throw new Error('createSaasApp requires options.hashPassword when options.registration is provided.');
    }
  }
```

- [ ] **Étape 5 : Types dans `CreateSaasAppOptions`**

```ts
  /**
   * Self-service sign-up. allow(email) is the product's rule (invitation list,
   * domain…); a refusal and an address already taken get the same 403.
   * Requires hashPassword. Mounts POST /auth/register.
   */
  registration?: {
    allow(email: string): Promise<boolean>;
    /** Role given to new accounts. Default 'member'. */
    role?: string;
    /** Default: at least 12 characters. Pass createPasswordRules(...).isValid from @astratra/client to share the screen's rule. */
    isValidPassword?(password: string): boolean;
  };
```

- [ ] **Étape 6 : Lancer, vérifier le succès**

Run : `npm test --workspace @astratra/saas-kit`
Attendu : toute la suite PASS.

- [ ] **Étape 7 : Point d'arrêt** — Kongo committe. Message proposé : `feat(saas-kit): inscription filtrée par l'application`

---

### Tâche 4 : Documentation, versions et vérification complète

**Fichiers :**
- Modifier : `packages/security/package.json` (1.12.0), `packages/saas-kit/package.json` (1.7.0, dépendance `@astratra/security` `^1.12.0`), `packages/security/README.md`, `packages/saas-kit/README.md`, `CHANGELOG.md` des deux paquets, planchers dans `packages/create-astratra-app` si ses tests l'exigent.

- [ ] **Étape 1 : README**

Dans `security/README.md`, une section « Jetons d'identité (Google, Apple) » avec l'exemple :

```js
const { createGoogleIdTokenVerifier, createAppleIdTokenVerifier } = require('@astratra/security');

const google = createGoogleIdTokenVerifier({ audiences: [process.env.GOOGLE_IOS_CLIENT_ID] });
const apple = createAppleIdTokenVerifier({ audiences: ['com.example.app'] });
const profile = await google(idTokenFromThePhone); // { subject, email, emailVerified, claims }
```

Dans `saas-kit/README.md`, une section « Connexion Google/Apple et inscription » avec :

```js
const app = createSaasApp({
  // …
  hashPassword,
  externalSignIn: {
    providers: { google, apple },
    resolveUser: async ({ provider, profile }) => {
      if (!profile.emailVerified || !profile.email) return null;
      return (await usersStore.findByEmail(profile.email)) ?? null;
    }
  },
  registration: { allow: async (email) => invitations.has(email) }
});
```

- [ ] **Étape 2 : Versions et changelogs** (mineures, ajouts sans rupture).

- [ ] **Étape 3 : Vérification complète depuis la racine**

Run : `cd ~/astratra && npm test && npm run lint && npm run typecheck && npm run verify:packages`
Attendu : tout vert.

- [ ] **Étape 4 : Aperçu de publication**

Run : `bash scripts/publish-all.sh --dry-run`
Attendu : seuls `@astratra/security` 1.12.0 et `@astratra/saas-kit` 1.7.0 (et `create-astratra-app` si ses planchers ont bougé) partiraient.

- [ ] **Étape 5 : Point d'arrêt** — Kongo committe puis publie (`bash scripts/publish-all.sh`).
