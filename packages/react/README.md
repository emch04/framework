# @astratra/react

Primitives React optionnelles pour une session, des permissions et des appels
API. Le package n'impose ni endpoints, ni routes, ni ecrans, ni design.

## Installation

```bash
npm install @astratra/react react
```

## Session injectee par l'application

L'application garde le controle de son backend. Elle fournit seulement les
fonctions qui lisent, ouvrent et ferment une session :

```jsx
import { createApiFetch, RequireAuth, SessionProvider, useSession } from '@astratra/react';

const apiFetch = createApiFetch({ baseUrl: import.meta.env.VITE_API_URL });
const getSession = () => apiFetch('/api/auth/session');
const signIn = (credentials) => apiFetch('/api/auth/login', { method: 'POST', body: credentials });
const signOut = () => apiFetch('/api/auth/logout', { method: 'POST' });

function Account() {
  const { user, signOut: logout } = useSession();
  return <button onClick={logout}>Deconnexion de {user.name}</button>;
}

export function App() {
  return (
    <SessionProvider getSession={getSession} signIn={signIn} signOut={signOut}>
      <RequireAuth fallback={<p>Connexion requise.</p>}><Account /></RequireAuth>
    </SessionProvider>
  );
}
```

## Exports

- `SessionProvider` : gere le chargement et l'etat de session a partir de callbacks fournis par l'application.
- `useSession()` : retourne `status`, `session`, `user`, `signIn`, `signOut` et `refresh`.
- `useUser()` : retourne l'utilisateur connecte ou `null`.
- `usePermissions()` : retourne `permissions`, `has(permission)` et `hasAny(permissions)`.
- `RequireAuth` et `RequireRole` : affichent un `fallback` lorsque l'acces manque. `RequireRole` lit `session.roles`, `user.roles` ou `user.role`.
- `createApiFetch()` : fabrique un client avec cookies HttpOnly et erreurs `ApiError`.

## Cookies et securite

`createApiFetch` utilise toujours `credentials: 'include'`. Le backend doit
configurer CORS, `HttpOnly`, `Secure`, `SameSite` et une protection CSRF adaptee
a son environnement. Astratra ne remplace pas cette configuration —
`@astratra/security` fournit ces primitives cote backend (voir son README).

**CSRF** : depuis `0.2.0`, `createApiFetch` lit lui-meme le cookie
`astratra_csrf` et l'attache en header `x-csrf-token` sur toute requete
mutante (tout sauf `GET`/`HEAD`/`OPTIONS`) — les noms par defaut
correspondent exactement a ceux de `@astratra/security`, aucune config
requise pour la paire habituelle backend/frontend Astratra. N'ecrase jamais
un header `x-csrf-token` deja fourni explicitement. Options :

```jsx
createApiFetch({
  csrf: false,                     // desactive completement l'auto-attachement
  csrfCookieName: 'mon_cookie',    // si le backend ne suit pas les noms par defaut
  csrfHeaderName: 'x-mon-header'
});
```

## Par rapport a `@astratra/saas-kit-ui`

`@astratra/saas-kit-ui` expose aussi des primitives de session
(`AuthProvider`/`useAuth`), mais avec un choix different : token JWT garde
en memoire JS et attache en `Authorization: Bearer`, couple a son dashboard
complet `AstratraDashboardApp`. Ce package-ci (`@astratra/react`) ne stocke
aucun token cote client — la session reste dans un cookie `HttpOnly` gere
par le backend — et n'impose ni dashboard ni ecran. Choisis `saas-kit-ui` si
`AstratraDashboardApp` te convient tel quel ; choisis `@astratra/react` si
tu construis ta propre interface par-dessus un backend en sessions cookie
`HttpOnly`.
