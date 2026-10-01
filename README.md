# Astratra

Astratra aide à démarrer vite une base SaaS propre, sans réécrire les mêmes
briques à chaque projet : utilisateurs, rôles, sécurité applicative, stores,
dashboard et points d'extension IA.

La v1 pose une base stable pour construire dessus. Elle donne les briques
communes, puis ton projet ajoute son métier, ses écrans, ses règles produit et
ses contraintes de sécurité.

En clair : Astratra te donne le départ solide, pas l'application finale à ta
place.

## Ce Que Ça Donne

Avec une commande, tu peux créer une app qui démarre déjà avec une API, un
dashboard, une auth, des rôles, des settings, des notifications, et des
fichiers prêts à adapter pour MongoDB, PostgreSQL et l'IA.

La v1 veut dire que les packages publics ont des contrats assez stables pour
être utilisés par d'autres projets. Ça ne veut pas dire que ton app est finie,
que tout est sécurisé automatiquement ou qu'Astratra décide à ta place.

`@astratra/store-mongo` et `@astratra/store-postgres` apportent chacun un
adapter de persistance réel avec le même contrat,
`@astratra/saas-kit-ui` apporte l'interface React réutilisable, et
`create-astratra-app` sert de générateur pour créer une app Astratra avec une
commande.

Les 40 paquets publiés sont tous en version 1.x (plus aucun en 0.x depuis le
1er octobre 2026). Chacun est versionné indépendamment ; les versions exactes
sont dans [CHANGELOG.md](CHANGELOG.md).

### Socle et sécurité

| Package | Rôle |
|---|---|
| [`@astratra/core`](packages/core/README.md) | réponses API, gestion d'erreurs, logs, request id, config env |
| [`@astratra/security`](packages/security/README.md) | primitives JWT/RBAC, rate limiting (mémoire ou Redis optionnel), CSP configurable, WAF heuristique, WebAuthn/passkeys, signature HMAC entre services, journal d'audit chaîné |
| [`@astratra/credentials`](packages/credentials/README.md) | clés de service chiffrées en base, éditables depuis l'interface, sans redémarrage : catalogue, garde valeur réelle/test, code de déverrouillage, hydratation de `process.env` |
| [`@astratra/entitlements`](packages/entitlements/README.md) | qui a le droit de quoi : plans et fonctionnalités, gardes de facturation et de statut, matrice écran/rôle, isolation par locataire qui échoue fermée, invitations par lien ; droits IA : clés à empreinte, modèles et groupes par plan, quotas, budgets jour/mois, repli dont chaque cible est revérifiée avant l'appel |
| [`@astratra/flags`](packages/flags/README.md) | fonctionnalités et expériences évaluées de façon déterministe : ciblage, déploiement progressif, fournisseur compatible OpenFeature |
| [`@astratra/privacy`](packages/privacy/README.md) | droit d'accès, droit à l'oubli par approbation humaine, anonymisation qui préserve les dossiers à conserver, nettoyage des journaux |
| [`@astratra/resilience`](packages/resilience/README.md) | disjoncteur à sonde unique, cache TTL qui se dégrade au lieu d'échouer, relance avec recul et brouillage |
| [`@astratra/i18n-server`](packages/i18n-server/README.md) | traduction des messages renvoyés par l'API (la clé est la phrase source), résolution de langue, audit de lisibilité des messages d'erreur |

### IA

| Package | Rôle |
|---|---|
| [`@astratra/ai`](packages/ai/README.md) | routage IA multi-fournisseur avec quotas/repli/Redis optionnel, registre d'outils, boucle d'agent avec garde contre les appels répétés, mise de côté des gros résultats d'outil (lus ensuite par tranches), niveaux de risque par outil et confirmation humaine au-dessus d'un seuil, repli déterministe ; fournisseur llama.cpp pour un modèle local sur CPU |
| [`@astratra/models`](packages/models/README.md) | service local de modèles pour un VPS sans carte graphique (vecteurs, reclasseur, NLI, entités, transcription) avec jeton et limites, son client Node qui ne lève jamais, générateurs pm2 et systemd ; catalogue des prix des modèles hébergés et calcul du coût d'un appel (cache, audio, long contexte, surcharges locales, fenêtre de contexte, capacités) |
| [`@astratra/memory`](packages/memory/README.md) | souvenirs par personne d'un assistant d'IA : stockage, vecteurs et modèle injectés, rappel hybride sens + mots, doublons fusionnés, corrections annulables, consolidation après conversation, portrait, voir/effacer même IA coupée, outils pour `@astratra/ai` |
| [`@astratra/rag`](packages/rag/README.md) | recherche dans des documents pour un assistant d'IA : découpage par paragraphes, vecteurs injectés marqués de leur modèle (jamais deux espaces mélangés), recherche mixte mots + sens, reclasseur optionnel borné dans le temps, vérification des sources, indexation continue ; lecture de documents (PDF, Office, images) par un service Docling, tableaux rendus en Markdown |
| [`@astratra/voice`](packages/voice/README.md) | synthèse vocale côté serveur (Piper, ffmpeg, cache versionné), chaîne de fournisseurs avec rotation des clés, découpage de la voix, garde anti-écho, détection des transcriptions douteuses, règle du mode confidentiel ; voix et transcription locales sur CPU (sherpa-onnx dans le processus, ou service faster-whisper) |
| [`@astratra/live`](packages/live/README.md) | appel vocal en direct avec une IA : session serveur, adaptateur temps réel injecté (Gemini Live fourni), mode confidentiel local, outils avec confirmation à voix haute, minutes comptées, reprise de conversation bornée dans le temps, protocole et états de l'écran d'appel côté client |
| [`@astratra/app-guide`](packages/app-guide/README.md) | guide d'usage pour un assistant d'IA, généré depuis la configuration des écrans de l'appli : filtré par rôle, détection des questions « comment faire », recherche bornée, contrôles de couverture routes et clés de traduction |
| [`@astratra/repomap`](packages/repomap/README.md) | carte pondérée des symboles d'un dépôt (tree-sitter), pour explorer du code dans un budget de jetons |

### Métier

| Package | Rôle |
|---|---|
| [`@astratra/payments`](packages/payments/README.md) | le tuyau des webhooks de paiement : signature sur corps brut, protection contre les rejeux, et les réponses qui empêchent un prestataire de relancer pendant des jours |
| [`@astratra/ledger`](packages/ledger/README.md) | comptabilité en partie double : écritures équilibrées et immuables, numérotation sans trou, clôture, lettrage, rapprochement bancaire, états SYSCOHADA, plans OHADA (SYSCOHADA, SYSCEBNL), TVA de la RDC (données par pays) |
| [`@astratra/booking`](packages/booking/README.md) | moteur de créneaux de rendez-vous sans base imposée : disponibilités par ressource, exceptions et jours fériés, fuseaux et heure d'été, durées, battements, préavis, horizon, capacité, réservation atomique par magasin injecté, annulation et report |
| [`@astratra/collab`](packages/collab/README.md) | édition collaborative en temps réel : serveur Hocuspocus branché sur ton authentification (lecture/écriture par document), persistance injectée en instantanés Yjs, versions nommées et restauration, limites de taille, éditeur Tiptap sans interface, conversion Yjs vers JSON/Markdown/HTML |
| [`@astratra/srs`](packages/srs/README.md) | répétition espacée sur FSRS : cartes, notation (Again/Hard/Good/Easy), prochaine échéance, paramètres FSRS, file du jour et statistiques, magasin injecté |
| [`@astratra/fhir`](packages/fhir/README.md) | aides FHIR R4 sur les types officiels Medplum : validation minimale de Patient, Encounter et Observation, références et constructeurs |
| [`@astratra/loyalty`](packages/loyalty/README.md) | carte à tampons : N visites dans une fenêtre de temps ouvrent une récompense, compteur remis à zéro dès qu'elle est utilisée, fin de mois sans glissement ; carte à quota mensuel : N passages par mois dans le fuseau du commerce, remise à zéro le 1er, double scan à confirmer, QR à jeton et numéro tapé au comptoir |
| [`@astratra/wallet`](packages/wallet/README.md) | cartes Apple Wallet et Google Wallet qui se tiennent à jour : signature, service web Apple et push, classe et carte Google, lien d'ajout signé, contrôle des clés avant enregistrement ; retrait d'une carte (Apple grisée, Google inactive, appareils oubliés) |
| [`@astratra/pdf`](packages/pdf/README.md) | primitives de mise en page PDFKit : texte borné qui ne déborde jamais, tableaux qui se paginent sans couper une rangée, planches de cartes au format carte bancaire avec QR vectoriel et logos des réseaux |
| [`@astratra/closure`](packages/closure/README.md) | clôture de période volontaire : liste à points bloquants et reconnus, archive nettoyée de tout identifiant, sections en échec nommées |
| [`@astratra/notify`](packages/notify/README.md) | messages sortants — e-mail, SMS, push : transport injecté, ne lève jamais, en-têtes protégés de l'injection, abonnements morts rendus pour élagage |

### Applications web et mobiles

| Package | Rôle |
|---|---|
| [`@astratra/saas-kit`](packages/saas-kit/README.md) | starter : `createSaasApp()` assemblant users/auth/settings/notifications/dashboard, validation d'entrée intégrée |
| [`@astratra/store-mongo`](packages/store-mongo/README.md) | adapter de persistance réel (MongoDB/Mongoose) pour `usersStore`/`settingsStore` |
| [`@astratra/store-postgres`](packages/store-postgres/README.md) | adapter de persistance réel (PostgreSQL/`pg`) pour `usersStore`/`settingsStore` |
| [`@astratra/saas-kit-ui`](packages/saas-kit-ui/README.md) | dashboard React complet et prêt à l'emploi pour `@astratra/saas-kit`, session JWT en mémoire (`Authorization: Bearer`) |
| [`@astratra/react`](packages/react/README.md) | primitives React nues pour une UI à construire soi-même, session cookie `HttpOnly` sans dashboard imposé — voir son README pour le choix vs `saas-kit-ui` |
| [`@astratra/client`](packages/client/README.md) | plomberie côté client, agnostique : rafraîchissement 401 à vol unique, garde de route à liste publique, règles de mot de passe, file hors ligne |
| [`@astratra/prerender`](packages/prerender/README.md) | prérendu SEO générique pour un site Vite + React : un HTML par route, shell SPA préservé, sitemap issu de la même liste que les pages |
| [`@astratra/native`](packages/native/README.md) | plomberie mobile sans le moteur mobile : session dans le trousseau, verrou biométrique, notifications natives et veille au premier plan, retour de paiement — adaptateurs injectés, testable en Node |
| [`@astratra/native-ui`](packages/native-ui/README.md) | kit d'interface mobile React Native / Expo : verre liquide d'Apple sur iOS et surface visible calibrée sur Android, boutons en verre, cartes pâles, barres qui se replient au défilement, barre d'onglets à pastille, en-tête repliable, rendu Markdown des réponses d'IA — règles pures testables en Node (`/logic`) |
| [`@astratra/app-version`](packages/app-version/README.md) | prévenir d'une nouvelle version dans les magasins : route publique des versions, une annonce par version (réservée avant l'envoi, en journée, aux seuls téléphones en retard, dans la langue de chacun, éteinte par défaut), veilleur côté téléphone |
| [`create-astratra-app`](packages/create-astratra-app/README.md) | générateur CLI : socle complet, briques optionnelles via `--with`, application Expo via `--template mobile` |

### Outillage et tests

| Package | Rôle |
|---|---|
| [`@astratra/tooling`](packages/tooling/README.md) | CLI : audit secrets/routes/i18n, lanceur de tests, orchestrateur de déploiement ; publication mobile sans question (App Store, Google Play), déploiement distant avec retour arrière, commandes SSH forcées ; évaluation d'une IA sur un jeu de cas (`astratra eval`, moteur promptfoo optionnel) avec seuil de réussite |
| [`@astratra/testkit`](packages/testkit/README.md) | bases de test jetables (MongoDB ou PostgreSQL en conteneur), fausses données reproductibles par pays, garde qui refuse toute adresse de base qui ressemble à la production |

| Exemple | Rôle |
|---|---|
| [`examples/dashboard-ui`](examples/dashboard-ui/README.md) | exemple React + Vite consommant `@astratra/saas-kit-ui` et l'API `saas-kit` (non publié) |

La base est testée, typée et vérifiée localement. Les détails restent dans le
code et les scripts, pas dans le discours marketing.

## Philosophie

Astratra ne décide pas ton métier à ta place. Les choses qui changent d'un
produit à l'autre restent injectées par ton app :

- `createAuthMiddleware` de `@astratra/security` prend un callback optionnel
  `verifySession(decoded)` au lieu d'interroger une collection Mongoose
  codée en dur pour la révocation de session. Il accepte aussi une allowlist
  d'algorithmes JWT, un issuer et une audience.
- `createProviderRouter` de `@astratra/ai` prend un tableau `providers` que
  vous définissez — aucun catalogue Groq/Gemini/Mistral intégré.
- `createSaasApp` de `@astratra/saas-kit` prend `usersStore`,
  `settingsStore`, `notify` et `verifyPassword` — aucune base de données,
  algorithme de hash ou canal de notification fixé.

Les rôles sont toujours de simples strings fournis par le projet
consommateur. Un projet peut utiliser `owner`/`admin`/`member`, un autre
`manager`/`operator`/`client` : rien dans Astratra n'impose un domaine ou une
organisation précise.

## Démarrage rapide

Créer une application complète :

```bash
npm create astratra-app@latest my-app
cd my-app
npm install
npm run dev:api
npm run dev:web
```

Ajouter des briques dès la génération — sans `--with`, le projet est exactement
celui d'avant :

```bash
npm create astratra-app@latest my-app -- --with payments,privacy,notify
npm create astratra-app@latest my-app -- --with all
```

Créer une API seule :

```bash
npm create astratra-app@latest my-api -- --template api
cd my-api
npm install
npm run dev:api
```

Installer les packages à la main dans un projet existant :

```bash
# Socle et sécurité
npm install @astratra/core @astratra/security @astratra/credentials @astratra/entitlements
npm install @astratra/flags @astratra/privacy @astratra/resilience @astratra/i18n-server
# IA
npm install @astratra/ai @astratra/models @astratra/memory @astratra/rag
npm install @astratra/voice @astratra/live @astratra/app-guide @astratra/repomap
# Métier
npm install @astratra/payments @astratra/ledger @astratra/booking @astratra/collab
npm install @astratra/srs @astratra/fhir @astratra/loyalty @astratra/wallet
npm install @astratra/pdf pdfkit
npm install @astratra/closure @astratra/notify
# Applications web et mobiles
npm install @astratra/saas-kit
npm install @astratra/store-mongo mongoose
npm install @astratra/store-postgres pg
npm install @astratra/saas-kit-ui react react-dom
npm install @astratra/react @astratra/client @astratra/prerender
npm install @astratra/native @astratra/app-version
npm install @astratra/native-ui react react-native react-native-reanimated expo-glass-effect expo-blur expo-linear-gradient
# Outillage et tests (en dépendances de développement)
npm install -D @astratra/tooling @astratra/testkit
```

## Développement du monorepo

```bash
npm install
npm test --workspaces
```

Tester l'exemple dashboard :

```bash
npm run dev:backend --workspace @astratra/dashboard-ui-example
npm run dev --workspace @astratra/dashboard-ui-example
```

## Exemple : E-Commerce

```bash
npm create astratra-app@latest astratra-shop
cd astratra-shop
npm install
npm run dev:api
npm run dev:web
```

Tu obtiens une base SaaS avec auth, rôles, settings, dashboard et
notifications. Ensuite tu ajoutes le métier e-commerce : catalogue, panier,
commandes, paiements et gestion des produits — via `extendRoutes`, pas en
appelant `app.use()` sur l'app retournée après coup (elle termine déjà sa
propre pile par un 404 générique) :

```js
const app = createSaasApp({
  // ...
  cors: { allowedOrigins: [process.env.WEB_ORIGIN] }, // optionnel, voir README saas-kit
  extendRoutes: (app, { authMiddleware, csrfMiddleware }) => {
    app.get('/api/products', authMiddleware, listProducts);
    app.post('/api/orders', authMiddleware, csrfMiddleware, createOrder);
  }
});
```

## Installation manuelle minimale

Backend :

```bash
npm install @astratra/saas-kit @astratra/security @astratra/core
```

Persistance MongoDB :

```bash
npm install @astratra/store-mongo mongoose
```

Persistance PostgreSQL :

```bash
npm install @astratra/store-postgres pg
```

Dashboard React :

```bash
npm install @astratra/saas-kit-ui react react-dom
```

Primitives React sans dashboard :

```bash
npm install @astratra/react react
```

Clés de service chiffrées en base :

```bash
npm install @astratra/credentials
```

Plans, droits d'accès et commission :

```bash
npm install @astratra/entitlements
```

Messages du serveur traduits :

```bash
npm install @astratra/i18n-server
```

Mise en page PDF :

```bash
npm install @astratra/pdf pdfkit
```

Webhooks de paiement :

```bash
npm install @astratra/payments
```

Vie privée et droit à l'oubli :

```bash
npm install @astratra/privacy
```

Résilience (disjoncteur, cache, relance) :

```bash
npm install @astratra/resilience
```

Clôture de période et archives :

```bash
npm install @astratra/closure
```

Messages sortants (e-mail, SMS, notifications poussées) :

```bash
npm install @astratra/notify
```

Plomberie côté client (session, hors-ligne) :

```bash
npm install @astratra/client
```

Routage IA, boucle d'agent, modèle local llama.cpp :

```bash
npm install @astratra/ai
```

Prix des modèles et service local de modèles :

```bash
npm install @astratra/models
```

Comptabilité en partie double :

```bash
npm install @astratra/ledger
```

Prise de rendez-vous :

```bash
npm install @astratra/booking
```

Édition collaborative :

```bash
npm install @astratra/collab
```

Répétition espacée :

```bash
npm install @astratra/srs
```

Drapeaux de fonctionnalités :

```bash
npm install @astratra/flags
```

Bases de test jetables (Docker et Node 22.22 ou plus) :

```bash
npm install -D @astratra/testkit @testcontainers/postgresql   # ou @testcontainers/mongodb
```

## Commandes utiles

```bash
npm create astratra-app@latest my-app
cd my-app
npm install
npm run dev:api
npm run dev:web
```

## Structure du repo

```
astratra/
├── .github/workflows/ci.yml   — tests sur Node 20.x/22.x à chaque push/PR
├── packages/                  — les 40 paquets publiés (un dossier chacun, voir le tableau)
├── examples/
│   └── dashboard-ui/          — exemple non publié
├── scripts/
│   ├── publish-all.sh         — publication dans l'ordre des dépendances
│   └── verify-package-installation.js — chaque archive installée et chargée dans un projet vierge
├── docs/
│   ├── PUBLISHING.md          — règles de version et de publication
│   └── design/                — specs écrits avant l'implémentation des premiers paquets
└── LICENSE                    — MIT
```

Les premiers paquets ont été construits à partir d'un spec écrit dans
`docs/design/` avant de coder ; tous sont vérifiés de la même façon :
dépendances installées avec un vrai accès réseau, tests réellement exécutés,
code relu, grep pour s'assurer qu'aucune logique métier n'a fui dans un
package.

## Publication mainteneur

Depuis le 1er octobre 2026, tous les paquets sont en 1.x : un nouveau paquet
naît en 1.0.0, jamais en 0.x. La publication passe par
`scripts/publish-all.sh`, qui suit l'ordre des dépendances internes, refuse
de démarrer si un paquet manque à sa liste ou s'il est placé avant une de ses
dépendances, et saute ceux déjà en ligne à la bonne version :

```bash
bash scripts/publish-all.sh --dry-run   # ce qui partirait
bash scripts/publish-all.sh
```

Règles, ordre complet et vérifications avant publication :
[docs/PUBLISHING.md](docs/PUBLISHING.md).

`examples/dashboard-ui` est un exemple de repo et n'est pas un package npm.

## Positionnement V1

Astratra 1.0 est fait pour aller vite au début d'un projet sans partir dans le
vide. Il convient pour tester une idée, lancer un MVP sérieux ou réutiliser
les mêmes briques entre plusieurs apps.

Il ne remplace pas le code métier, un audit sécurité, une stratégie
d'infrastructure, le paiement, les règles légales ou le design final du
produit.

## Limites connues (V1)

- **Le dashboard (`examples/dashboard-ui`) reste un exemple de repo.** Le package
  publié est `@astratra/saas-kit-ui`; l'exemple ne sert qu'à tester et montrer
  son intégration avec un backend de développement.
- **Deux adapters de persistance réels existent** (`@astratra/store-mongo`,
  `@astratra/store-postgres`), mais pas d'adapter SQL générique (MySQL,
  SQLite) ni de migrations. Le store de credentials WebAuthn reste une
  interface sans implémentation fournie.
- **La boucle d'agent d'`@astratra/ai` ne gère pas les images (vision).**
  La confirmation humaine par niveau de risque et le flux token par token
  existent ; la vision reste hors périmètre (voir `packages/ai/README.md`).
- **Le WAF d'`@astratra/security` est une couche heuristique.** Il aide à
  bloquer des patterns évidents, mais ne remplace pas les requêtes
  paramétrées, la sanitation adaptée au contexte ou un WAF réseau.
- **WebAuthn/passkeys reste une primitive d'intégration.** Une app qui veut
  en faire un argument commercial fort doit auditer son intégration complète.
- **Pas de chiffrement au repos généralisé (seules les clés de service sont chiffrées en base, via `@astratra/credentials`) ni d'audit de logs de sécurité centralisé**
  fournis par Astratra — à la charge du projet consommateur selon ses
  besoins de conformité.

## Contribuer / étendre

Ajouter un nouveau package en écrivant d'abord son spec de design
(`docs/design/AAAA-MM-JJ-astratra-<nom>-design.md`), en suivant
la même forme que les specs existants : ce qui est extrait, ce qui est
explicitement exclu, et comment ça reste découplé de la logique métier d'un
produit précis.
