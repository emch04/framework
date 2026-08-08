# Astratra — interface dashboard

Exemple de dashboard React + Vite pour `@astratra/saas-kit`.
L'interface reusable vit dans le package `@astratra/saas-kit-ui`; ce dossier
sert seulement a tester l'integration avec un backend de developpement.

## Installation

Depuis la racine du repo :

```bash
npm install
```

## Backend de developpement

Cet exemple inclut un petit serveur Express qui importe `createSaasApp` depuis
`@astratra/saas-kit`, utilise les stores memoire de developpement, initialise
quelques settings et ecoute sur le port `4000`.

```bash
npm run dev:backend --workspace @astratra/dashboard-ui-example
```

Comptes de test :

- `owner@example.test` / `password`
- `member@example.test` / `password`

Le compte owner accede au dashboard, aux utilisateurs et aux settings. Le
compte member peut se connecter et voir le dashboard, mais les ecrans users
et settings affichent l'etat `403` retourne par le serveur.

Verifications rapides du backend :

```bash
curl -s http://localhost:4000/dashboard/summary
curl -s -X POST http://localhost:4000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.test","password":"password"}'
```

La route dashboard exige un bearer token ; la premiere commande doit donc
retourner une reponse API non autorisee si aucun token n'est fourni.

## Interface frontend

Copier le fichier d'environnement exemple si un override local est necessaire :

```bash
cp examples/dashboard-ui/.env.example examples/dashboard-ui/.env
```

Lancer Vite contre le backend :

```bash
npm run dev --workspace @astratra/dashboard-ui-example
```

Le fichier `src/main.jsx` importe `AstratraDashboardApp` depuis
`@astratra/saas-kit-ui`. Le code UI n'est donc plus duplique dans cet exemple.

Vérification de compilation :

```bash
npm run build --workspace @astratra/dashboard-ui-example
```
