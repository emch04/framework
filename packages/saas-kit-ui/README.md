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

## `AuthProvider`/`useAuth` vs `@astratra/react`

Deux packages Astratra exposent des primitives de session React, avec des
choix différents et volontaires — ce n'est pas un doublon accidentel :

- **`AuthProvider`/`useAuth` (ce package)** : garde le JWT en mémoire JS et
  l'attache en `Authorization: Bearer` via `apiFetch`. Couplé au dashboard
  complet `AstratraDashboardApp` (login/users/settings/overview) — conçu
  pour démarrer vite avec un backend `@astratra/saas-kit` standard, pas pour
  être réutilisé isolément dans une UI déjà existante.
- **`SessionProvider`/`useSession` (`@astratra/react`)** : ne stocke aucun
  token côté client — la session vit dans un cookie `HttpOnly` géré par le
  backend, l'app injecte juste `getSession`/`signIn`/`signOut`. Pas de
  dashboard imposé, pas de routes fixes ; à choisir quand tu construis ta
  propre UI par-dessus `@astratra/saas-kit` (avec les cookies de session
  activés côté `@astratra/security`) plutôt que d'utiliser
  `AstratraDashboardApp` tel quel.

En résumé : utilise ce package si `AstratraDashboardApp` te convient tel
quel ; utilise `@astratra/react` si tu construis ta propre interface et que
ton backend utilise les sessions cookie `HttpOnly` plutôt qu'un token Bearer
géré côté client.
