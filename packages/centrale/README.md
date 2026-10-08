# @astratra/centrale

Le paquet de collecte d'un tableau de bord de surveillance auto-hébergé : erreurs, plantages, vues, usages, sessions et appels d'IA, masqués à la source puis envoyés par lots au backend.

- **Aucune dépendance** à l'exécution, aucun autre paquet Astratra.
- **Ne lève jamais** chez l'appelant et ne bloque jamais le projet hôte.
- Écrit en TypeScript, publié en JavaScript avec ses types (`dist/`, construit par `npm run build` avant chaque publication).
- Porte le contrat d'envoi (`@astratra/centrale/envoi`) et le masquage (`@astratra/centrale/masquage`) : le backend du tableau de bord les reprend d'ici, il n'y a qu'une seule source.

## Installation

```sh
npm install @astratra/centrale
```

## Configuration

```ts
const config = {
  cle: 'clj_pub_…',                       // clé publique : envoyer seulement
  adresse: 'https://centrale.exemple.fr',
  environnement: 'production',            // 'production' | 'preproduction' | 'developpement'
  version: '2.14.0',
  sel: 'sel-du-projet',                   // pour hacher l'identifiant d'utilisateur
  noms: ['Dupont'],                       // noms propres à masquer partout
  echantillonnage: { vues: 0.5, usages: 1, ia: 1 }, // jamais pour les erreurs et sessions
  strict: false,                          // true : ni utilisateur, ni appareil précis
  desactive: false,                       // true : coupe tout (refus)
  debug: false                            // true : console.warn des erreurs internes
};
```

## Les 5 entrées

| Entrée | Usage |
| --- | --- |
| `@astratra/centrale` | `creerCentrale(config, transport?)` : `erreur(e, extra?)`, `vue(nom)`, `usage(nom, props?)`, `ia({…})`, `session(etat)`, `miette(categorie, message, donnees?)`, `definirUtilisateur(id)`, `vider()`. Le transport (fetch par défaut) est injectable. |
| `@astratra/centrale/node` | `demarrer(config)` ; `app.use(centrale.intergiciel())` en tête, `app.use(centrale.gestionnaireErreurs())` en fin. |
| `@astratra/centrale/navigateur` | `demarrer(config)` au chargement de l'app web. |
| `@astratra/centrale/expo` | `demarrer({ ...config, plateforme: Platform.OS, version, build, miseAJour, os, appareil, appState: AppState })`, puis `centrale.ecran(nom)` depuis la navigation. |
| `@astratra/centrale/ia` | `mesurerAppelIA({ fournisseur, modele, outil?, jetons?, estRepli? }, () => appel())`. |

```ts
import { demarrer } from '@astratra/centrale/node';
const centrale = demarrer(config);
app.use(centrale.intergiciel());
// … routes …
app.use(centrale.gestionnaireErreurs());
```

## Ce qui est capté

- **Node** : exceptions non attrapées (enregistrées en `fatal`, puis comportement normal de Node : pile et code 1), promesses rejetées sans gestionnaire (le plantage par défaut est conservé), requêtes Express (identifiant `X-Request-Id`, route en gabarit, durée, statut, miette), erreurs Express (statut ≥ 500 : `erreur`, sinon `avertissement`), vidage à la sortie (`beforeExit`, `SIGTERM`, `SIGINT`, 2 s au plus).
- **Navigateur** : `error` et `unhandledrejection` (sans remplacer `window.onerror`), vues SPA (`pushState`, `replaceState`, `popstate`) en gabarit, temps de chargement de la première page, sessions (début à l'ouverture, fin quand la page est cachée), envoi final par `navigator.sendBeacon` avec `?cle=`.
- **Expo** : `ErrorUtils.setGlobalHandler` (fatale : plantage, vidage puis gestionnaire précédent), sessions liées à `AppState` (fin après 30 s en arrière-plan), écrans. `signalerPlantageNatif(rapport)` attend le futur module natif (MetricKit, raison de dernière fermeture Android).
- **IA** : fournisseur, modèle, outil, durée, jetons, résultat (`ok`, `erreur`, `quota`, `repli`). **Jamais le contenu.**

Envoi : lots de 100 événements au plus (1 Mio au plus), toutes les 10 s ou dès 50 événements ; file de 500 événements (les plus vieux usages partent d'abord, jamais une erreur avant un usage) ; recul progressif (2 s, 4 s… plafonné à 5 min) ; `Retry-After` respecté sur 429 ; abandon silencieux sur 400, 401, 413 ; hors ligne, la file attend.

## Cartes de code

Si le build est passé par `centrale injecter` (paquet `@astratra/centrale-cli`), chaque cadre de pile reçoit le `debugId` de son fichier (lu dans `globalThis.__centraleDebugIds`), et l'erreur aussi quand toute la pile vient d'un seul fichier. Le backend s'en sert pour retrouver la vraie ligne. Rien à configurer.

## Vie privée

- Aucun cookie, aucun stockage local.
- Masquage **avant tout envoi** : e-mails, téléphones, cartes, IBAN, clés, jetons, mots de passe, et les `noms` fournis.
- Adresses ramenées à leur gabarit (`/eleve/123?token=x` devient `/eleve/:id`).
- Utilisateur : seulement une empreinte SHA-256 salée, jamais l'identifiant brut.
- Mode `strict` : ni utilisateur, ni appareil précis.
- Usages : propriétés simples seulement (texte court, nombre, booléen).

## Tests

```sh
npm test -w @astratra/centrale
npx tsc -p paquets/centrale/tsconfig.json --noEmit
```
