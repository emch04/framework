# Astratra React Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creer `@astratra/react`, des primitives React optionnelles pour session, permissions, protections et appels API avec cookies.

**Architecture:** Le package expose un contexte de session base sur des callbacks injectes par l'application. Les protections sont des composants sans dependance au routeur; le client API est une fabrique independante du contexte.

**Tech Stack:** React >= 18 en peer dependency, `react-test-renderer` en dependance de developpement et `node:test`.

## Global Constraints

- Aucun endpoint, role, route, stockage de token ou style impose.
- Les cookies HttpOnly passent par `credentials: 'include'`; CSRF reste configure cote backend.
- Le package reste ESM, public, avec documentation francaise.

---

### Task 1: Package et client API

**Files:**
- Create: `packages/react/package.json`
- Create: `packages/react/src/api.js`
- Create: `packages/react/__tests__/api.test.js`

**Interfaces:**
- Produces: `ApiError` et `createApiFetch(options)`.

- [ ] **Step 1: Ecrire les tests echouants**

```js
const apiFetch = createApiFetch({ baseUrl: 'https://api.test', fetchImpl });
await apiFetch('/session');
assert.equal(options.credentials, 'include');
assert.equal(url, 'https://api.test/session');
```

- [ ] **Step 2: Implementer `ApiError` et `createApiFetch`**

```js
export function createApiFetch({ baseUrl = '', onUnauthorized, fetchImpl = fetch } = {}) {
  return async (path, options = {}) => { /* JSON, credentials, erreurs HTTP */ };
}
```

- [ ] **Step 3: Executer `npm test --workspace @astratra/react`**

### Task 2: Contexte, hooks et protections

**Files:**
- Create: `packages/react/src/session.jsx`
- Create: `packages/react/src/index.jsx`
- Create: `packages/react/__tests__/session.test.js`

**Interfaces:**
- Consumes: `getSession`, `signIn`, `signOut` injectes dans `SessionProvider`.
- Produces: `SessionProvider`, `useSession`, `useUser`, `usePermissions`,
  `RequireAuth`, `RequireRole`.

- [ ] **Step 1: Ecrire les tests echouants**

```jsx
<SessionProvider getSession={async () => ({ user: { id: 'u1' }, permissions: ['users:read'] })}>
  <RequireRole role="users:read" fallback={<span>interdit</span>}><span>ok</span></RequireRole>
</SessionProvider>
```

- [ ] **Step 2: Implementer le reducer/context et les hooks**

```jsx
export function usePermissions() {
  const { session } = useSession();
  const permissions = session?.permissions ?? [];
  return { permissions, has: permission => permissions.includes(permission) };
}
```

- [ ] **Step 3: Executer les tests du workspace**

### Task 3: Documentation et integration monorepo

**Files:**
- Create: `packages/react/README.md`
- Modify: `README.md`
- Modify: `scripts/verify-package-installation.js`

**Interfaces:**
- Consumes: les exports publics des taches 1 et 2.
- Produces: installation, exemple et verification dans la CI locale.

- [ ] **Step 1: Documenter l'installation et l'exemple injecte**
- [ ] **Step 2: Ajouter le package a la verification d'installation**
- [ ] **Step 3: Lancer test, lint, typecheck et verification de package**

