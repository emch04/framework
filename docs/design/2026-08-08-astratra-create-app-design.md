# Astratra — Design create-astratra-app (V0)

## Contexte

Astratra doit pouvoir creer une application rapidement avec une seule commande.
Les packages fournissent les briques, mais sans generateur l'utilisateur doit
encore assembler l'API, le dashboard et les scripts a la main.

## Décision

La V0 ajoute le package npm `create-astratra-app`, avec le binaire
`create-astratra-app`. La commande principale est :

```bash
npm create astratra-app@latest my-app
```

Le generateur ecrit un projet, puis affiche les prochaines commandes. Il ne
lance pas `npm install` automatiquement afin de rester previsible et facile a
tester.

## Templates

- `fullstack` par defaut : API Express avec `@astratra/saas-kit`, dashboard
  React avec `@astratra/saas-kit-ui`, Vite, `.env.example`, scripts `dev:api`
  et `dev:web`.
- `api` : API Express seule, utile pour un backend pur ou une autre interface.

## Hors V0

- Pas d'installation automatique des dependances.
- Pas de selection interactive.
- Pas de template paiement, e-commerce ou IA specialisee ; ces modules pourront
  etre ajoutes une fois la base publiee et testee.

## Vérification

1. Les tests du package doivent verifier la generation `fullstack`.
2. Le generateur doit refuser un dossier non vide sauf avec `--force`.
3. Le starter genere doit utiliser les dependances npm publiques Astratra.
