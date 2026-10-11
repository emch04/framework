# Astratra

[English](README.md) | [Français](README.fr.md)

**Astratra est un framework et un ensemble de SDK pour construire des apps avec l'IA intégrée.**

C'est les deux à la fois, et la différence tient à qui commande :

- **Le framework.** `createSaasApp()` (`@astratra/saas-kit`) monte toute
  l'application — connexion, sessions, CSRF, comptes, erreurs — et appelle ton
  code aux endroits prévus (`extendRoutes`, `verifyPassword`, les stores).
  `create-astratra-app` donne sa forme à un nouveau projet.
- **Les SDK.** Des paquets qui parlent à un service pour toi, comme
  `@astratra/centrale` (surveillance, passerelle des clés, recherche) ou le
  client du service de modèles local dans `@astratra/models`.
- **Les briques.** Des bibliothèques que tu appelles toi-même, sans structure
  imposée : `@astratra/security`, `@astratra/client`, `@astratra/ai`,
  `@astratra/ledger` et les autres.

Le tout est livré en paquets npm indépendants pour des back-ends SaaS et des
interfaces web ou mobiles : utilisateurs, rôles, sessions, middleware de
sécurité, adaptateurs de persistance, tableau de bord, et les pièces communes
derrière les assistants d'IA, les paiements, la comptabilité, la prise de
rendez-vous et les applications mobiles.

Chaque paquet fait une chose et reçoit ses dépendances par injection : un
magasin, un transport, un modèle, une horloge, une source de clés. Ton
application décide des règles métier, de la base de données et des
fournisseurs ; Astratra fournit les parties qui sont les mêmes d'un projet à
l'autre.

## Pour qui

- Les développeurs qui démarrent un SaaS, un outil interne ou un MVP et veulent
  une base solide plutôt que réécrire l'authentification, la limitation de
  débit, les rôles et les réglages.
- Les équipes qui ont déjà une application et adoptent un paquet à la fois,
  par exemple le journal d'audit, le tuyau des webhooks de paiement ou le
  routeur d'IA.

## Ce que ce n'est pas

- Ce n'est pas une application finie. Tu écris toujours ton modèle métier, tes
  écrans et tes règles produit.
- Ce n'est pas un service hébergé : rien ne tourne à ta place.
- Ce n'est pas un audit de sécurité, un cadre de conformité ni un avis
  juridique. Les paquets de sécurité réduisent les risques courants ; ils ne
  dispensent pas de relire ta propre application.
- Il n'impose pas de modèle de rôles. Les rôles sont de simples chaînes
  fournies par ton projet.

## Prérequis

- Node.js 20 ou plus récent (la CI tourne sur 20.x et 22.x).
- npm workspaces : la racine du dépôt est un espace de travail npm.
- Docker, seulement pour `@astratra/testkit` (conteneurs MongoDB ou PostgreSQL
  jetables).

## Démarrage rapide

Créer une application complète (API, tableau de bord web, authentification,
rôles, réglages, notifications) :

```bash
npm create astratra-app@latest my-app
cd my-app
npm install
npm run dev:api
npm run dev:web
```

Créer une API seule :

```bash
npm create astratra-app@latest my-api -- --template api
```

Ajouter des briques optionnelles dès la génération avec `--with`, par exemple
`--with payments,privacy,notify`, ou `--with all`. Sans `--with`, le projet est
exactement celui d'avant.

## Installer des paquets dans un projet existant

Chaque paquet est publié séparément. N'installe que ce que tu utilises :

```bash
npm install @astratra/core @astratra/security
npm install @astratra/saas-kit @astratra/store-postgres pg
npm install @astratra/ai
```

Chaque paquet a un README avec son installation, un exemple minimal, ses
options principales et ce qu'il ne fait pas. Le tableau ci-dessous en donne les
liens.

## Paquets

Les 44 paquets de [`packages/`](packages/) sont publiés sous le périmètre
`@astratra`, sauf `create-astratra-app`, publié sous son propre nom. Les
versions sont celles de chaque `package.json` ; l'historique de chaque paquet
est dans [CHANGELOG.md](CHANGELOG.md).

### Socle et sécurité

| Paquet | Version | Rôle |
|---|---|---|
| [`@astratra/core`](packages/core/README.md) | 1.1.0 | Réponses d'API, erreurs, journaux, identifiants de requête, configuration par variables d'environnement |
| [`@astratra/security`](packages/security/README.md) | 1.12.1 | JWT et RBAC, limitation de débit (mémoire ou Redis), CSP, WAF heuristique, passkeys WebAuthn, HMAC entre services, journal d'audit chaîné |
| [`@astratra/credentials`](packages/credentials/README.md) | 1.1.0 | Clés de service chiffrées en base, modifiables depuis l'interface sans redémarrage |
| [`@astratra/entitlements`](packages/entitlements/README.md) | 1.0.0 | Plans, fonctionnalités, gardes de facturation et de statut, isolation par locataire qui échoue fermée, invitations par lien, quotas et budgets d'IA |
| [`@astratra/flags`](packages/flags/README.md) | 1.0.1 | Drapeaux de fonctionnalités et expériences déterministes : ciblage, déploiement progressif, fournisseur compatible OpenFeature |
| [`@astratra/privacy`](packages/privacy/README.md) | 1.0.0 | Droit d'accès, droit à l'effacement avec validation humaine, anonymisation, nettoyage des journaux |
| [`@astratra/resilience`](packages/resilience/README.md) | 1.1.0 | Disjoncteur, cache TTL qui se dégrade au lieu d'échouer, relance avec gigue, verrou de tâche à l'échelle du cluster |
| [`@astratra/i18n-server`](packages/i18n-server/README.md) | 1.0.0 | Traduction des messages d'API, résolution de la langue, audit de lisibilité des messages d'erreur |

### IA

| Paquet | Version | Rôle |
|---|---|---|
| [`@astratra/ai`](packages/ai/README.md) | 1.10.0 | Routage multi-fournisseur avec quotas et repli, registre d'outils, boucle d'agent, niveaux de risque avec confirmation, fournisseur llama.cpp local |
| [`@astratra/agent`](packages/agent/README.md) | 1.1.0 | Tâches durables, budgets, plans, vérifications de fin, résumés de contexte, suivi de la consommation et retours utilisateur (👍/👎) dont l'agent tient compte |
| [`@astratra/models`](packages/models/README.md) | 1.1.0 | Service local de modèles sur CPU (vecteurs, reclassement, NLI, entités, transcription) et son client Node ; catalogue des prix et calcul du coût |
| [`@astratra/conscience`](packages/conscience/README.md) | 1.2.0 | Mémoire documentée des décisions d'un agent (résultats, corrections, leçons avec preuves, modèle de soi, traçabilité, effacement) sous un gouverneur déterministe sans aucun modèle de langage |
| [`@astratra/memory`](packages/memory/README.md) | 2.0.0 | Souvenirs par personne pour un assistant : rappel hybride, fusion des doublons, corrections annulables, magasin PostgreSQL |
| [`@astratra/rag`](packages/rag/README.md) | 1.0.0 | Recherche dans des documents : découpage, vecteurs injectés, recherche mixte, vérification des sources, lecture de documents par un service optionnel |
| [`@astratra/voice`](packages/voice/README.md) | 1.1.0 | Synthèse vocale côté serveur (Piper, ffmpeg), caches versionnés, chaîne de fournisseurs avec rotation des clés, transcription locale |
| [`@astratra/live`](packages/live/README.md) | 1.0.0 | Sessions d'appel vocal en temps réel et aides au protocole côté client |
| [`@astratra/app-guide`](packages/app-guide/README.md) | 1.0.0 | Guide d'usage filtré par rôle, généré depuis la configuration des écrans, avec contrôle de couverture |
| [`@astratra/repomap`](packages/repomap/README.md) | 1.0.0 | Carte pondérée des symboles d'un dépôt, pour explorer du code dans un budget de jetons |

### Métier

| Paquet | Version | Rôle |
|---|---|---|
| [`@astratra/payments`](packages/payments/README.md) | 1.0.0 | Tuyau des webhooks de paiement : signature sur corps brut, protection contre les rejeux, réponses adaptées aux prestataires |
| [`@astratra/ledger`](packages/ledger/README.md) | 1.0.0 | Comptabilité en partie double : écritures équilibrées et immuables, numérotation sans trou, clôture, rapprochement, plans OHADA |
| [`@astratra/booking`](packages/booking/README.md) | 1.0.0 | Moteur de créneaux sans base imposée : disponibilités, exceptions, fuseaux, capacité, réservation atomique par magasin injecté |
| [`@astratra/collab`](packages/collab/README.md) | 1.0.0 | Édition collaborative en temps réel : serveur Hocuspocus branché sur ton authentification, instantanés Yjs, versions nommées |
| [`@astratra/srs`](packages/srs/README.md) | 1.0.0 | Répétition espacée sur FSRS : cartes, notation, échéances, file du jour, statistiques |
| [`@astratra/fhir`](packages/fhir/README.md) | 1.0.0 | Aides FHIR R4 sur les types officiels Medplum : validation minimale, références, constructeurs |
| [`@astratra/loyalty`](packages/loyalty/README.md) | 1.0.1 | Cartes à tampons et cartes à quota mensuel, calculées sans base de données |
| [`@astratra/wallet`](packages/wallet/README.md) | 1.0.0 | Cartes Apple Wallet et Google Wallet tenues à jour : signature, service web, lien d'ajout, retrait |
| [`@astratra/pdf`](packages/pdf/README.md) | 1.0.0 | Primitives de mise en page PDFKit : texte qui tient dans sa case, tableaux paginés, planches de cartes avec QR vectoriel |
| [`@astratra/closure`](packages/closure/README.md) | 1.0.0 | Liste de clôture de période à points bloquants et reconnus, archive sans aucun identifiant |
| [`@astratra/notify`](packages/notify/README.md) | 1.0.0 | Messages sortants : e-mail, SMS, push ; transport injecté, protégé contre l'injection d'en-têtes, ne lève jamais |

### Web et mobile

| Paquet | Version | Rôle |
|---|---|---|
| [`@astratra/saas-kit`](packages/saas-kit/README.md) | 2.0.0 | Démarrage côté serveur : `createSaasApp()` assemble utilisateurs, authentification, réglages, notifications et tableau de bord |
| [`@astratra/store-mongo`](packages/store-mongo/README.md) | 1.1.0 | Adaptateurs de persistance MongoDB (Mongoose) pour les magasins du SaaS |
| [`@astratra/store-postgres`](packages/store-postgres/README.md) | 1.1.0 | Adaptateurs de persistance PostgreSQL (`pg`) pour les magasins du SaaS |
| [`@astratra/saas-kit-ui`](packages/saas-kit-ui/README.md) | 1.4.0 | Tableau de bord React pour `@astratra/saas-kit`, barre de retours 👍/👎 |
| [`@astratra/react`](packages/react/README.md) | 1.0.0 | Primitives React nues pour sessions, permissions et appels d'API, sans tableau de bord imposé |
| [`@astratra/client`](packages/client/README.md) | 1.1.0 | Plomberie côté client indépendante du framework : rafraîchissement sur 401, garde de route, règles de mot de passe, file hors ligne |
| [`@astratra/prerender`](packages/prerender/README.md) | 1.0.0 | Prérendu SEO pour un site Vite et React : un HTML par route, sitemap issu de la même liste |
| [`@astratra/native`](packages/native/README.md) | 1.0.0 | Plomberie mobile : session dans le trousseau, verrou biométrique, enregistrement des notifications, retour de paiement |
| [`@astratra/native-ui`](packages/native-ui/README.md) | 1.2.0 | Kit d'interface React Native et Expo, dont la logique pure se teste dans Node, barre de retours 👍/👎 |
| [`@astratra/app-version`](packages/app-version/README.md) | 1.0.0 | Annonces de nouvelles versions d'applications mobiles : route publique des versions, une annonce par version |
| [`create-astratra-app`](packages/create-astratra-app/README.md) | 1.11.0 | Générateur de projets : pile complète, API seule ou application Expo, briques optionnelles |

### Supervision et outillage

| Paquet | Version | Rôle |
|---|---|---|
| [`@astratra/centrale`](packages/centrale/README.md) | 1.4.0 | Paquet de collecte pour un tableau de bord de surveillance auto-hébergé : erreurs, plantages, vues, usages, appels d'IA ; masqué à la source, envoyé par lots ; sans dépendance |
| [`@astratra/centrale-cli`](packages/centrale-cli/README.md) | 1.0.1 | Outil en ligne de commande du même tableau de bord : identifiants de débogage, cartes de code, déclaration des déploiements |
| [`@astratra/tooling`](packages/tooling/README.md) | 1.5.0 | Audit de l'espace de travail (secrets, routes, traductions), lanceur de tests, déploiement avec retour arrière, publication d'applications, évaluation d'IA |
| [`@astratra/testkit`](packages/testkit/README.md) | 1.1.0 | Bases de test MongoDB ou PostgreSQL jetables, fausses données reproductibles par pays, garde contre les bases de production |

L'exemple [`examples/dashboard-ui`](examples/dashboard-ui/README.md) montre
`@astratra/saas-kit-ui` branché sur l'API `saas-kit`. Il n'est pas publié.

## Principes

- **Injection, pas d'hypothèses.** Magasins, transports, modèles, fournisseurs,
  clés et horloges sont passés en paramètres. Un paquet ne code en dur ni ta
  base de données, ni ton fournisseur de courriel, ni ton fournisseur d'IA.
- **La sécurité comme contrainte.** Les paquets sensibles documentent leurs
  valeurs par défaut dans leur README, et chacun indique comment il traite les
  secrets.
- **Contrats 1.x stables.** Tous les paquets sont en 1.x ou plus. Une version
  mineure ajoute sans casser ; une version majeure change le comportement et
  est décrite dans [CHANGELOG.md](CHANGELOG.md).
- **Paquets indépendants.** Chaque paquet a sa version et ses dépendances.
  Tu installes ceux dont tu as besoin ; aucun ne t'en impose un autre hors des
  dépendances déclarées.
- **Testé et vérifié.** L'intégration continue lance le lint, le typage, toutes
  les suites de tests de l'espace de travail, et installe chaque paquet publié
  dans un projet vierge.

## Limites de la version actuelle

- Il n'existe pas d'adaptateur SQL générique (MySQL, SQLite) ni d'outil de
  migrations. Les adaptateurs MongoDB et PostgreSQL sont les deux adaptateurs
  de persistance réels.
- La boucle d'agent de `@astratra/ai` ne gère pas les images (vision). La
  confirmation humaine par niveau de risque et le flux de jetons existent.
- Le WAF de `@astratra/security` est une couche heuristique. Il ne remplace ni
  les requêtes paramétrées, ni l'encodage de sortie adapté au contexte, ni un
  WAF réseau.
- Les passkeys WebAuthn sont une primitive d'intégration ; le magasin des
  identifiants est une interface sans implémentation fournie.
- Astratra ne chiffre pas toute la base au repos (seules les clés de service
  gérées par `@astratra/credentials` sont chiffrées) et ne fournit pas de
  journal de sécurité centralisé. Ton projet décide de ses besoins de
  conformité.

## Contribuer

Voir [CONTRIBUTING.md](CONTRIBUTING.md) pour l'installation, les tests, le lint,
les versions et les demandes de fusion. Pour signaler une vulnérabilité, voir
[SECURITY.md](SECURITY.md) ; n'ouvre pas de ticket public pour cela.

## Développement

```bash
npm install
npm test --workspaces
npm run lint
npm run typecheck
```

Les règles de publication (versions, ordre, vérifications) sont dans
[docs/PUBLISHING.md](docs/PUBLISHING.md).

## Organisation du dépôt

```
.github/workflows/   intégration continue (lint, typage, tests, installation des paquets)
packages/            les 43 paquets publiés, un dossier chacun
examples/            l'exemple de tableau de bord, non publié
scripts/             script de publication et vérification d'installation
docs/                règles de publication, notes de conception, guides
```

## Licence

[MIT](LICENSE). Copyright (c) 2026 Astratra contributors.
