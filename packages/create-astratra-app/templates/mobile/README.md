# __PROJECT_NAME__

Application mobile Expo, montée sur `@astratra/native` et `@astratra/client`.

## Démarrer

```bash
npm install
cp .env.example .env
npm start
```

L'URL de l'API a une valeur de développement par défaut : `localhost:3000/api`
sur simulateur iOS, `10.0.2.2:3000` sur émulateur Android — celui-ci tourne
dans sa propre VM réseau, où « localhost » désigne l'émulateur lui-même.

## Ce qui est déjà là

| Fichier | Rôle |
|---|---|
| `services/session.ts` | trousseau, jetons, rafraîchissement à vol unique, langue par appel |
| `services/push.ts` | notifications natives : canaux, catégories, enregistrement de l'appareil |
| `features/routes.ts` | ce qui est public, et où une notification a le droit de mener |
| `context/AuthContext.tsx` | qui est connecté, restauration au lancement, déconnexion propre |
| `components/SessionGuard.tsx` | la pile fermée derrière la session |
| `app/` | splash, accueil public, connexion, mot de passe oublié, tableau de bord, réglages, notifications |
| `components/KeyboardScreen.tsx` | l'écran qui survit au clavier — enveloppe tout formulaire |
| `components/glass/` | la surface de verre : flou natif iOS, réfraction Skia, repli ailleurs |
| `components/dashboard/` | en-tête, cloche, bandeau de KPI, tuiles, barre d'onglets, apparition en cascade |
| `constants/dashboard.ts` | ce que le tableau de bord affiche, **en données** — c'est ce qu'on édite pour changer d'application |

## Le clavier

Tout écran portant un formulaire s'enveloppe dans `KeyboardScreen`. Ne recopiez
pas un `KeyboardAvoidingView` à la main : Expo règle Android en
`softwareKeyboardLayoutMode: 'resize'`, donc le système redimensionne déjà la
fenêtre. Ajouter `behavior="height"` par-dessus corrige deux fois la même chose
et fait sauter la mise en page. iOS, lui, ne redimensionne pas et a besoin de
`padding`. `KeyboardScreen` tranche une fois pour toutes.

## Un *development build*, pas Expo Go

L'application démarre dans Expo Go pour un aperçu rapide, mais deux choses n'y
fonctionnent pas :

- **les notifications push** — retirées d'Expo Go depuis le SDK 53 ;
- **l'effet de verre** — Skia et `expo-glass-effect` sont des modules natifs.

```bash
npx expo run:ios      # ou run:android
```

C'est de toute façon ce dont a besoin une vraie application livrée à un client.

## Ce qu'il faut changer en premier

1. `app.config.js` — nom, slug, `scheme`, identifiants iOS/Android.
2. `features/routes.ts` — les écrans publics et les routes de notification de
   VOTRE application. Les deux listes nomment ce qui est **autorisé** : un
   écran ajouté plus tard et oublié reste fermé, ce qui est le bon défaut.
3. `services/push.ts` — les canaux Android et les points d'API qui
   enregistrent un appareil.
4. `constants/theme.ts` — couleurs et espacements.
5. `i18n/locales/` — les textes.

## Ce qui n'est pas fourni

Le métier. Les écrans livrés sont le socle qu'aucune application ne réécrit :
se connecter, rester connecté, être notifié, se déconnecter. Ce qui distingue
votre application se construit par-dessus.
