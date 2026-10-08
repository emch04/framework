# @astratra/react

Primitives React optionnelles pour une session, des permissions et des appels API. Le paquet n'impose ni points d'accès, ni routes, ni écrans, ni design : l'application fournit les fonctions qui lisent, ouvrent et ferment la session, et le paquet gère l'état, les permissions et le client HTTP. Il vise les interfaces construites sur un backend à sessions par cookie `HttpOnly`.

## Installation

```bash
npm install @astratra/react react
```

React 18 ou plus récent, Node 20 ou plus récent pour l'outillage.

## Exemple

```jsx
import { createApiFetch, RequireAuth, SessionProvider, useSession } from '@astratra/react';

const apiFetch = createApiFetch({ baseUrl: import.meta.env.VITE_API_URL });
const getSession = () => apiFetch('/api/auth/session');
const signIn = (credentials) => apiFetch('/api/auth/login', { method: 'POST', body: credentials });
const signOut = () => apiFetch('/api/auth/logout', { method: 'POST' });

function Account() {
  const { user, signOut: logout } = useSession();
  return <button onClick={logout}>Déconnexion de {user.name}</button>;
}

export function App() {
  return (
    <SessionProvider getSession={getSession} signIn={signIn} signOut={signOut}>
      <RequireAuth fallback={<p>Connexion requise.</p>}><Account /></RequireAuth>
    </SessionProvider>
  );
}
```

`getSession` doit rendre un objet de session (`{ user, permissions?, roles? }`) ou `null` quand personne n'est connecté. Une erreur levée par `getSession` est traitée comme « anonyme ».

## Exports

| Export | Rôle |
| --- | --- |
| `SessionProvider` | Charge et garde l'état de session à partir de `getSession`, `signIn` et `signOut`. |
| `useSession()` | Rend `status` (`loading`, `authenticated` ou `anonymous`), `session`, `user`, `signIn`, `signOut` et `refresh`. |
| `useUser()` | Rend l'utilisateur connecté ou `null`. |
| `usePermissions()` | Rend `permissions`, `has(permission)` et `hasAny(permissions)`. |
| `RequireAuth` | Affiche ses enfants si l'utilisateur est connecté, sinon `fallback`. |
| `RequireRole` | Comme `RequireAuth`, avec la prop `role` ; lit `session.roles`, `user.roles` ou `user.role`. |
| `createApiFetch(options)` | Fabrique un client `apiFetch(chemin, { method, headers, body })`. |
| `ApiError` | Erreur levée pour une réponse en échec (`status`, `data`, `error`). |

## Options de `createApiFetch`

| Option | Rôle |
| --- | --- |
| `baseUrl` | Préfixe des chemins (vide par défaut). |
| `onUnauthorized` | Fonction appelée sur une réponse 401. |
| `fetchImpl` | Implémentation de `fetch` à utiliser (celle de l'environnement par défaut). |
| `csrf` | `false` désactive l'ajout automatique du jeton CSRF (activé par défaut). |
| `csrfCookieName` | Cookie lu pour le jeton (`astratra_csrf` par défaut). |
| `csrfHeaderName` | En-tête portant le jeton (`x-csrf-token` par défaut). |

Le corps d'une requête est sérialisé en JSON s'il n'est pas déjà du texte. La réponse rendue est `payload.data` si elle existe, sinon la charge utile entière.

## Cookies et sécurité

`createApiFetch` utilise toujours `credentials: 'include'`. Le backend doit configurer CORS, `HttpOnly`, `Secure`, `SameSite` et une protection CSRF adaptée à son environnement ; `@astratra/security` fournit ces primitives côté backend.

Sur toute requête autre que `GET`, `HEAD` et `OPTIONS`, `createApiFetch` lit le cookie CSRF et l'envoie dans l'en-tête configuré, sans écraser un en-tête fourni explicitement. Les noms par défaut sont ceux de `@astratra/security`.

## Ce que le paquet ne fait pas

- Il ne stocke aucun jeton côté client : la session reste dans le cookie géré par le backend.
- Il ne fournit ni écran de connexion, ni routeur, ni design.
- Il ne remplace pas la configuration CORS, cookies et CSRF du backend.

## Par rapport à `@astratra/saas-kit-ui`

`@astratra/saas-kit-ui` expose aussi des primitives de session (`AuthProvider`, `useAuth`), mais garde un jeton JWT en mémoire, l'envoie en `Authorization: Bearer` et l'associe à son tableau de bord complet `AstratraDashboardApp`. Choisissez `saas-kit-ui` si ce tableau de bord vous convient tel quel ; choisissez `@astratra/react` si vous construisez votre propre interface sur un backend à sessions par cookie `HttpOnly`.

## Licence

MIT.
