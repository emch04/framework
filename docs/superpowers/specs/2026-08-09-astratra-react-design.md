# Astratra React - Design

## Objectif

Ajouter `@astratra/react`, un package React optionnel qui fournit des
primitives d'authentification et d'autorisation sans imposer ni API, ni routes,
ni interface graphique a une application.

## Contrat

`SessionProvider` recoit un adaptateur fourni par l'application :

```jsx
<SessionProvider getSession={getSession} signIn={signIn} signOut={signOut}>
  <App />
</SessionProvider>
```

- `getSession()` retourne `null` ou `{ user, permissions? }`.
- `signIn(credentials)` et `signOut()` sont optionnels et restent entierement
  definis par l'application consommatrice.
- `useSession()` expose `status` (`loading`, `authenticated`, `anonymous`),
  `session`, `user`, `signIn`, `signOut` et `refresh`.
- `useUser()` retourne l'utilisateur de session ou `null`.
- `usePermissions()` expose `permissions`, `has(permission)` et
  `hasAny(permissions)`.
- `RequireRole` lit les roles depuis `session.roles`, `session.user.roles` ou
  `session.user.role`.
- `RequireAuth` et `RequireRole` affichent un `fallback` lorsque la session ou
  l'autorisation manque. Ils n'effectuent aucune redirection et ne dependent
  pas de React Router.
- `createApiFetch({ baseUrl, onUnauthorized, fetchImpl })` fournit une fonction
  compatible avec les cookies HttpOnly, utilise `credentials: 'include'` et
  genere `ApiError` pour les reponses HTTP non reussies.

## Limites

Le package n'impose aucun endpoint (`/api/auth/session` reste un choix de
l'application), ne stocke aucun token, ne dessine aucun ecran et ne remplace
pas la configuration CSRF/cookies du backend.

## Tests

Les tests couvrent les transitions de session, la verification de permissions,
les fallbacks de protection et `createApiFetch` (cookies, URL, 401/403).
