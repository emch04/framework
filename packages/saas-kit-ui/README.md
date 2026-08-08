# @astratra/saas-kit-ui

Interface React reutilisable pour demarrer rapidement un dashboard SaaS
Astratra. Le package expose une application dashboard complete et quelques
primitives (`AuthProvider`, `useAuth`, `apiFetch`) pour composer une interface
plus specifique.

## Installation

```bash
npm install @astratra/saas-kit-ui react react-dom
```

Dans le repo Astratra, `examples/dashboard-ui` montre son integration avec un
backend `@astratra/saas-kit`.

## Utilisation

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

Par defaut, l'interface appelle `http://localhost:4000`. Avec Vite, definis
`VITE_API_URL` pour pointer vers ton backend :

```bash
VITE_API_URL=http://localhost:4000 npm run dev
```

## Surface exportee

- `AstratraDashboardApp` : dashboard complet login/users/settings/overview.
- `AuthProvider` et `useAuth` : session bearer token en memoire.
- `apiFetch` et `ApiError` : client minimal compatible avec les reponses
  `apiResponse` d'`@astratra/core`.

Le package ne contient pas de serveur Express et ne fixe aucun domaine metier.
Le backend reste fourni par `@astratra/saas-kit` ou par ton application.
