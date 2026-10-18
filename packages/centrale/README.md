# @astratra/centrale

[English](README.en.md) | Français

Le paquet de collecte d'un tableau de bord de surveillance auto-hébergé : erreurs, plantages, vues, usages, sessions et appels d'IA, masqués à la source puis envoyés par lots au backend.

- **Aucune dépendance** à l'exécution, aucun autre paquet Astratra.
- **Ne lève jamais** chez l'appelant et ne bloque jamais le projet hôte.
- Écrit en TypeScript, publié en JavaScript avec ses types (`dist/`, construit par `npm run build` avant chaque publication).
- Porte le contrat d'envoi (`@astratra/centrale/envoi`) et le masquage (`@astratra/centrale/masquage`) : le backend du tableau de bord les reprend d'ici, il n'y a qu'une seule source.

## Installation

```sh
npm install @astratra/centrale
```

## Exemple minimal

```ts
import { creerCentrale } from '@astratra/centrale';

const centrale = creerCentrale({
  cle: 'clj_pub_…',                          // clé publique du projet
  adresse: 'https://centrale.exemple.fr',    // backend du tableau de bord
  environnement: 'production',
  version: '2.14.0'
});

centrale.vue('/eleve/123');                  // enregistré comme « /eleve/:id »
centrale.usage('export_pdf', { pages: 3 });
try {
  // …
} catch (e) {
  centrale.erreur(e);
}
await centrale.vider();                      // envoie ce qui reste en file ; ne rejette jamais
```

Pour Node, le navigateur, Expo ou la mesure des appels d'IA, utilisez le point d'entrée dédié (tableau plus bas).

## Configuration

Seuls `cle`, `adresse` et `environnement` sont obligatoires.

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

| Option | Rôle |
| --- | --- |
| `cle` | Clé publique du projet (`clj_pub_…`) : elle sert seulement à envoyer. |
| `adresse` | Adresse du backend. |
| `environnement` | `'production'`, `'preproduction'` ou `'developpement'`. |
| `version` | Version de l'app ou du serveur. |
| `sel` | Sel servant à hacher l'identifiant d'utilisateur. |
| `noms` | Noms propres à masquer partout. |
| `echantillonnage` | Taux de 0 à 1 pour `vues`, `usages` et `ia` ; jamais appliqué aux erreurs ni aux sessions. |
| `strict` | Ni utilisateur, ni appareil précis. |
| `desactive` | Coupe tout : l'instance ne fait rien. |
| `debug` | Affiche les erreurs internes avec `console.warn`. |
| `robots` | Navigateur seulement. `false` par défaut : un navigateur piloté par un robot (`navigator.webdriver`, c'est-à-dire Playwright, Selenium, Puppeteer) ne collecte rien. `true` pour collecter quand même (tester la collecte elle-même). |

### Tests automatisés : rien n'est envoyé

Depuis la 1.5.0, `demarrer` de `/navigateur` rend une instance inactive (`centrale.actif === false`) quand
`navigator.webdriver` vaut `true` : les tests de bout en bout lancés contre un déploiement ne remplissent plus le
tableau de bord de fausses erreurs. Pour vérifier la collecte dans un test Playwright, demande-la :

```ts
const centrale = demarrer({ ...config, robots: true });
```

## Les 6 entrées

| Entrée | Usage |
| --- | --- |
| `@astratra/centrale` | `creerCentrale(config, transport?)` : `erreur(e, extra?)`, `vue(nom)`, `usage(nom, props?)`, `ia({…})`, `session(etat)`, `miette(categorie, message, donnees?)`, `definirUtilisateur(id)`, `vider()`. Le transport (fetch par défaut) est injectable. |
| `@astratra/centrale/node` | `demarrer(config)` ; `app.use(centrale.intergiciel())` en tête, `app.use(centrale.gestionnaireErreurs())` en fin. |
| `@astratra/centrale/navigateur` | `demarrer(config)` au chargement de l'app web. |
| `@astratra/centrale/expo` | `demarrer({ ...config, plateforme: Platform.OS, version, build, miseAJour, os, appareil, appState: AppState, stockage })`, puis `centrale.ecran(nom)` depuis la navigation. `stockage` (AsyncStorage, expo-file-system…) garde l'état entre deux lancements. |
| `@astratra/centrale/ia` | `mesurerAppelIA({ fournisseur, modele, outil?, jetons?, estRepli? }, () => appel())`. |
| `@astratra/centrale/conscience` | `creerConscienceCentrale({ adresse, jeton })` : réglages de la conscience d'une IA, bilan du matin, décisions humaines (section plus bas). |

```ts
import { demarrer } from '@astratra/centrale/node';
const centrale = demarrer(config);
app.use(centrale.intergiciel());
// … routes …
app.use(centrale.gestionnaireErreurs());
```

## Passerelle des clés (`/passerelle`)

Une app n'y garde qu'un jeton de projet (`CENTRALE_PASSERELLE_JETON`, `clj_pas_…`) et l'adresse de Centrale (`CENTRALE_ADRESSE`) : Centrale appelle les fournisseurs avec les clés de son coffre et compte la consommation par projet.

```ts
import { lirePasserelle, modeleDiscussion, passerelleDabord, plongements, rechercher, voix } from '@astratra/centrale/passerelle';
const passerelle = lirePasserelle(process.env);          // null si non réglée : l'app garde ses clés directes
const modele = passerelle && modeleDiscussion(passerelle); // { url, baseUrl, apiKey, model: 'auto', thoughtSignatures: true } au format OpenAI, à mettre en tête du relais
const resultats = await passerelleDabord(passerelle, (p) => rechercher(p, { requete: 'météo Paris' }), () => rechercheDirecte());
```

Une panne de la passerelle (injoignable, 5xx, 429, 401/403, service non configuré) lève `PasserelleIndisponible` : `passerelleDabord` passe alors aux clés directes. Une requête refusée pour elle-même (400, 413) lève `RequetePasserelleRefusee`, sans repli.

## Journal des agents (`/agents`)

Une IA y envoie chacune de ses exécutions (tours de modèle, outils appelés, jetons, durée, coût, statut, actions proposées) au tableau de bord : `POST /v1/agents`, avec la clé **publique** du projet (`X-Centrale-Cle`), 100 exécutions par lot au plus.

```ts
import { construireExecution, creerJournalAgents } from '@astratra/centrale/agents';

const journal = creerJournalAgents({ adresse: process.env.CENTRALE_ADRESSE!, cle: process.env.CENTRALE_CLE! });

await journal.envoyer([construireExecution({
  identifiant: 'run-123', agent: 'Elsa', mode: 'discussion', utilisateur: idDuCompte,   // identifiant opaque
  debut, fin, statut: 'ok',                                                              // ok | erreur | interrompue | en_attente_confirmation
  tours: [{ modele: 'modele-a', dureeMs: 900, jetonsEntree: 1200, jetonsSortie: 80, cout: 0.002 }],
  outils: [{ outil: 'lire_stock', succes: true, dureeMs: 25 }],
  actions: [{ outil: 'rembourser', etat: 'proposee' }]
})]);
```

- `construireExecution(bilan, { inclureContenu? })` : fonction pure. **Sans contenu par défaut** : ni question, ni réponse, ni arguments, ni résultats d'outils, même si le bilan les porte ; l'erreur est un code court (`ia_indisponible`), jamais un message. `inclureContenu: true` les joint (masqués avant l'envoi) ; à n'activer que pour un usage qui l'exige.
- `creerJournalAgents({ adresse, cle, fetch? })` : `envoyer(executions)` valide en local (une clé inconnue, un statut, un type d'étape ou un état d'action hors liste **refuse** l'exécution ; étapes, sources et actions coupées aux bornes du format ; dates à la seconde, `Z`), masque les textes, met en file et envoie. `vider()`, `enAttente()`, `arreter()`.
- La file est en mémoire (1 000 exécutions au plus). Un échec réseau, un 5xx ou un 429 (`Retry-After` respecté) remet le lot en file avec un recul progressif (2 s, doublé jusqu'à 5 min) ; un refus 4xx abandonne le lot en silence. Ne lève jamais ; `debug: true` explique les refus.

## Conscience d'une IA (`/conscience`)

Le tableau de bord règle la conscience d'une IA (allumée, arrêt d'urgence, approbateurs, réflexion automatique,
cycles par jour), reçoit son bilan du matin et ses propositions en attente, et enregistre les décisions humaines.
Il n'applique jamais rien : l'IA lit ses réglages et les décisions, puis les soumet à son propre gouverneur.
L'authentification se fait par le jeton de projet (`Authorization: Bearer …`).

```ts
import { creerConscienceCentrale } from '@astratra/centrale/conscience';

const tableau = creerConscienceCentrale({ adresse: 'https://centrale.exemple.fr', jeton: process.env.JETON_PROJET! });

const reglages = await tableau.lireReglages();              // gardés avec leur ETag : un 304 rend la copie
await tableau.envoyerBilan(await governor.morningReport({ organisationId, since }),
  await governor.listProposals({ organisationId, status: 'pending_approval' }));
const decisions = await tableau.lireDecisions();             // celles qui ne sont pas encore accusées
await tableau.accuserDecisions(resultats);                   // applied, already_applied, refused (+ code)
```

| Méthode | Route | Rôle |
| --- | --- | --- |
| `lireReglages()` | `GET /v1/conscience/settings` | Réglages (`conscience-settings/1`), avec `If-None-Match` ; lève `ErreurConscience` si le tableau de bord ne répond pas |
| `envoyerBilan(rapport, propositions?)` | `POST /v1/conscience/report` | Bilan et liste **complète** des propositions en attente, réduits par `resumerBilan` |
| `lireDecisions({ toutes? })` | `GET /v1/conscience/decisions` | Décisions non accusées (avec `toutes` : toutes, curseur en mémoire) |
| `accuserDecision(id, { result, code })` | `POST /v1/conscience/decisions/:id/ack` | Ce que le gouverneur a fait de la décision |
| `accuserDecisions(resultats)` | idem | Accuse une liste ; un résultat `failed` n'est pas accusé et revient au passage suivant |

`resumerBilan(rapport, propositions?)` ne garde que des identifiants, des codes (`answer_style`, `tool_reliability`…)
et des nombres : ni question, ni réponse, ni note, ni identifiant de décision, ni objet `tests`, ni plan de retour
arrière, ni propriétaire, ni identité d'une personne qui propose. Une chaîne que le masquage changerait est retirée.
Le tableau de bord vérifie à nouveau et refuse tout envoi qui contient autre chose.

Les erreurs sont des `ErreurConscience` : `statut` HTTP (ou `null` hors ligne) et `code` (`invalid_api_key`,
`sensitive_data`, `reseau`…).

## Ce qui est capté

- **Node** : exceptions non attrapées (enregistrées en `fatal`, puis comportement normal de Node : pile et code 1), promesses rejetées sans gestionnaire (le plantage par défaut est conservé), requêtes Express (identifiant `X-Request-Id`, route en gabarit, durée, statut, miette), erreurs Express (statut ≥ 500 : `erreur`, sinon `avertissement`), vidage à la sortie (`beforeExit`, `SIGTERM`, `SIGINT`, 2 s au plus).
- **Navigateur** : `error` et `unhandledrejection` (sans remplacer `window.onerror`), vues SPA (`pushState`, `replaceState`, `popstate`) en gabarit, temps de chargement de la première page, sessions (début à l'ouverture, fin quand la page est cachée), envoi final par `navigator.sendBeacon` avec `?cle=`.
- **Expo** : `ErrorUtils.setGlobalHandler` (fatale : plantage, vidage puis gestionnaire précédent), sessions liées à `AppState` (fin après 30 s en arrière-plan), écrans. `signalerPlantageNatif(rapport)` attend le futur module natif (MetricKit, raison de dernière fermeture Android).
- **Surveillance renforcée** (navigateur et Expo, `/vigilance`, désactivable option par option) :
  - requêtes `fetch` dans le fil d'Ariane (gabarit, statut, durée) ; pas de réponse, 5xx, 408 et 429 signalés (`RequeteSansReponse`, `RequeteEchouee`) ; les envois à la Centrale et les annulations ne comptent pas (`requetes`) ;
  - `console.error` signalé (une fois par message toutes les 10 s), `console.warn` dans le fil d'Ariane (`console`) ;
  - les vérifications de connexion des systèmes et des bibliothèques (`generate_204` de Google, `captive.apple.com`, `msftconnecttest.com`, `detectportal.firefox.com`…) restent dans le fil d'Ariane mais ne sont jamais signalées : leur échec dit seulement que le réseau manque (`estVerificationDeConnexion(adresse)`) ;
  - gardien du fil principal : interface bloquée plus de 2 s signalée (`AppBloquee`, erreur au-delà de 5 s), en pause en arrière-plan et, sur Expo, dès l'état `inactive` (centre de contrôle, sélecteur d'apps, verrouillage en cours) (`blocages`). Un retard de la minuterie de plus de 60 s n'est pas un blocage mais une **pause de l'app** (téléphone verrouillé, onglet endormi : JavaScript a été suspendu avant d'apprendre le passage en arrière-plan) : seulement une miette « Pause de l'app N s », sans erreur. Ce plafond se règle par `plafondMs` en appelant `surveillerBlocages(centrale, { plafondMs })` de `@astratra/centrale/vigilance` ;
  - Expo : promesses rejetées sans `catch` (Hermes, `promesses`), alerte mémoire d'iOS (`MemoireSaturee`, au plus une fois par minute), premier plan, arrière-plan et lancement dans le fil d'Ariane ;
  - avec un `stockage` : le fil d'Ariane, l'écran et la session ouverte sont gardés au fil de l'eau ; au lancement suivant, une session restée ouverte est close « anormale » (ou « plantage » après une erreur fatale), et une fermeture au premier plan est signalée (`FermetureInattendue`, avec le fil d'Ariane et l'écran). Navigateur : à réserver aux apps ouvertes dans un seul onglet.
- **IA** : fournisseur, modèle, outil, durée, jetons, résultat (`ok`, `erreur`, `quota`, `repli`). **Jamais le contenu.**

Envoi : lots de 100 événements au plus (1 Mio au plus), toutes les 10 s ou dès 50 événements ; file de 500 événements (les plus vieux usages partent d'abord, jamais une erreur avant un usage) ; recul progressif (2 s, 4 s… plafonné à 5 min) ; `Retry-After` respecté sur 429 ; abandon silencieux sur 400, 401, 413 ; hors ligne, la file attend.

## Cartes de code

Si le build est passé par `centrale injecter` (paquet `@astratra/centrale-cli`), chaque cadre de pile reçoit le `debugId` de son fichier (lu dans `globalThis.__centraleDebugIds`), et l'erreur aussi quand toute la pile vient d'un seul fichier. Le backend s'en sert pour retrouver la vraie ligne. Rien à configurer.

## Vie privée

- Aucun cookie ; aucun stockage local sans `stockage` (il ne garde que le fil d'Ariane déjà masqué, l'écran et l'identifiant de session).
- Masquage **avant tout envoi** : e-mails, téléphones, cartes, IBAN, clés, jetons, mots de passe, et les `noms` fournis.
- Adresses ramenées à leur gabarit (`/eleve/123?token=x` devient `/eleve/:id`).
- Utilisateur : seulement une empreinte SHA-256 salée, jamais l'identifiant brut.
- Mode `strict` : ni utilisateur, ni appareil précis.
- Usages : propriétés simples seulement (texte court, nombre, booléen).

## Ce que le paquet ne fait pas

- Il n'héberge ni backend ni tableau de bord : il envoie les événements à l'adresse que vous indiquez.
- Il ne capte pas le contenu des appels d'IA, ni les cookies.
- Les rapports de plantage natifs (iOS, Android) ne sont pas encore captés : `signalerPlantageNatif` attend un module natif.

## Licence

MIT.

## Tests

```sh
npm test -w @astratra/centrale
npx tsc -p packages/centrale/tsconfig.json --noEmit
```
