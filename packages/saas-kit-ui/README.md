# @astratra/saas-kit-ui

Interface React réutilisable pour démarrer rapidement un tableau de bord SaaS. Le paquet expose une application complète (connexion, vue d'ensemble, utilisateurs, réglages) et quelques primitives (`AuthProvider`, `useAuth`, `apiFetch`) pour composer une interface plus spécifique. Il est prévu pour un backend `@astratra/saas-kit`.

## Installation

```bash
npm install @astratra/saas-kit-ui react react-dom
```

React 18 ou plus récent. Le dépôt contient `examples/dashboard-ui`, qui montre l'intégration avec un backend `@astratra/saas-kit`.

## Exemple

```jsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AstratraDashboardApp } from '@astratra/saas-kit-ui';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AstratraDashboardApp />
  </React.StrictMode>
);
```

Le paquet importe sa feuille de styles avec l'application ; elle est aussi disponible séparément via `@astratra/saas-kit-ui/styles.css`. Par défaut, l'interface appelle `http://localhost:4000`. Avec Vite, définissez `VITE_API_URL` pour pointer vers votre backend :

```bash
VITE_API_URL=https://api.exemple.fr npm run dev
```

## Ce que le tableau de bord attend du backend

| Écran | Appels |
| --- | --- |
| Connexion | `POST /auth/login` avec `{ email, password }` ; réponse `{ token, user }`. |
| Vue d'ensemble | `GET /dashboard/summary` |
| Utilisateurs | `GET /users?limit=50&offset=0`, `POST /users` |
| Réglages | `GET /settings`, `PATCH /settings/<clé>` avec `{ value }` |

Les réponses suivent le format `apiResponse` d'`@astratra/core` : `{ success, data, message }`.

## Exports

| Export | Rôle |
| --- | --- |
| `AstratraDashboardApp` (aussi export par défaut) | Tableau de bord complet. |
| `AuthProvider`, `useAuth` | Session par jeton Bearer gardé en mémoire ; `useAuth()` rend `isAuthenticated`, `token`, `user`, `login`, `logout` et `request`. |
| `apiFetch(chemin, options)`, `ApiError` | Client minimal. Options : `apiUrl`, `token`, `method`, `body`, `fetcher`, `onUnauthorized`. |
| `Layout`, `Notice` | Composants de mise en page et de message. |
| `DashboardScreen`, `LoginScreen`, `SettingsScreen`, `UsersScreen` | Les écrans, réutilisables séparément. |

## Ce que le paquet ne fait pas

- Il ne contient pas de serveur et ne fixe aucun domaine métier ; le backend est fourni par `@astratra/saas-kit` ou par votre application.
- Le jeton n'est gardé qu'en mémoire : un rechargement de la page déconnecte l'utilisateur.
- Il n'est pas conçu pour être branché sur une interface existante qui utilise des sessions par cookie `HttpOnly` : voir `@astratra/react`.

## `AuthProvider`/`useAuth` et `@astratra/react`

- **`AuthProvider`/`useAuth` (ce paquet)** : garde le JWT en mémoire et l'envoie en `Authorization: Bearer` via `apiFetch`. Couplé à `AstratraDashboardApp`.
- **`SessionProvider`/`useSession` (`@astratra/react`)** : ne stocke aucun jeton côté client ; la session vit dans un cookie `HttpOnly` géré par le backend. Pas de tableau de bord imposé.

Utilisez ce paquet si `AstratraDashboardApp` vous convient tel quel ; utilisez `@astratra/react` si vous construisez votre propre interface sur des sessions par cookie.

## Licence

MIT.
