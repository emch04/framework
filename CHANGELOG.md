# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Chaque package Astratra est versionné indépendamment.

## 2026-10-20 — Failles critiques corrigées : `@astratra/tooling` 1.6.2, dépendances du dépôt

`npm audit` relevait 4 failles critiques ; il n'en reste aucune. Les 45 alertes restantes (aucune critique) viennent toutes de 4 failles d'origine sans correctif utilisable, voir plus bas.

### Sécurité
- `proxy-addr` 2.0.7 → 2.0.8 (usurpation d'adresse IP par une adresse IPv6 qui contient une IPv4, GHSA-jqcg-44mw-7w3h) : dépendance d'Express, donc de tous les serveurs. Dans le dépôt, le fichier de verrouillage est corrigé ; une application qui utilise un paquet Astratra avec Express prend 2.0.8 par une simple réinstallation (`npm update proxy-addr`), la plage d'Express l'accepte.
- `shell-quote` 1.10.0 → 1.12.0 (injection de commande par `quote()`, GHSA-pqg4-j6r4-53mv) : outils de React Native, côté construction mobile.
- `brace-expansion` 1.1.21 et 2.1.7, `source-map-js` 1.2.2, `moment` 2.31.0 (déni de service, traversée de chemin) : fichier de verrouillage seulement. `npm audit fix` aurait aussi monté React Native 0.86 → 0.88 et Metro 0.84 → 0.87 : écarté, seuls ces trois paquets sont mis à jour.
- Restent sans correctif utilisable, vérifiés un par un le 20/10/2026 :
  - `node-forge` ≤ 1.4.0 (vérification de signature RSA trop permissive ; 1.4.0 est la dernière version) : `@astratra/wallet` passe par `passkit-generator`, qui **signe** les cartes et ne vérifie aucune signature, donc non concerné ; ailleurs, outils Expo et `promptfoo` (développement) ;
  - `braces` ≤ 3.0.3 (dernière version) et `sprintf-js` ≤ 1.1.3 (dernière version) : outils de construction et de test (Metro, Jest), sur des motifs écrits par les développeurs ;
  - `basic-ftp` ≤ 6.2.0 : par `promptfoo` → `get-uri`, dont même la dernière version exige `basic-ftp` 5 (la correction n'existe qu'en 6) ; lecture de dossiers FTP, en développement seulement.
- `@astratra/tooling` 1.6.2 : `promptfoo` ^0.124.1 (développement) et `>=0.124.1` (dépendance facultative de `astratra eval`) ; les versions précédentes tiraient `simple-git` ≤ 3.36.0 (exécution de commandes, GHSA-g4wm-2vf7-vfgr, GHSA-858h-whjf-mvg5, GHSA-x6jw-m9v5-85vh, GHSA-v5rq-49vh-5v5c).

### Modifié
- README (anglais et français) : tableau des versions à jour.

## 2026-10-20 — `@astratra/tooling` 1.6.1 : version d'Electron en plage acceptée

### Corrigé
- `publish windows|mac|desktop` : electron-builder refusait une version d'Electron écrite en plage dans le `package.json` de l'application (`"electron": "^44.5.1"`) ; la version installée (lue dans `node_modules/electron`, ou à la racine de l'espace de travail) lui est maintenant donnée (`electronVersion`), et `--dry-run` l'affiche. Relevé le 20/10/2026 sur Examen d'État, qui avait dû la figer à la main ; vérifié par une construction réelle avec `^44.5.1`.

## 2026-10-20 — `@astratra/tooling` 1.6.0 : publication d'applications de bureau Electron

Demande d'Emch pour Examen d'État (application Electron + Vite, utilisateurs surtout sous Windows) : étendre l'outil commun plutôt qu'écrire un script par projet.

### Ajouté
- `astratra publish windows|mac|desktop` : construction par electron-builder sur la machine, installateur NSIS (`.exe`) pour Windows, `.dmg` et `.zip` pour macOS ; montée de version dans le `package.json` de l'application (`--bump=patch|minor|major|none`), redescendue si rien n'a pu être construit ; `--out=DIR` ; `--dry-run` (application, version, cibles, signature, noms des installateurs, rien de construit).
- Section `publish.desktop` de `astratra.config.json` (`appDir`, `appId`, `productName`, `platforms`, `icons`, `targets`, `arch`, `outputDir`, `buildScript`, `files`, `versionBump`, `signing`, `nsis`, `electronBuilder`, `command`), validée avec des refus qui nomment ce qui manque, avant toute montée de version. La configuration electron-builder est générée dans un fichier temporaire, jamais publiée (`--publish=never`) ; noms de fichiers simples tirés du nom du produit.
- Signature facultative par plateforme (`auto`, `required`, `off`), certificats lus dans l'environnement seulement (`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `CSC_LINK`, `CSC_KEY_PASSWORD`, `CSC_NAME`) ; un certificat situé dans le projet est refusé.
- `npm` et `npx` lancés par `cmd.exe` sous Windows (arguments entre guillemets), pour construire sur Windows ou en CI.

### Documentation
- README : configuration, signature, construction de Windows depuis un Mac (vérifiée sans Wine le 20/10/2026 avec electron-builder 26, installateur non signé ; espace de travail npm embarqué), limites, exemple GitHub Actions. README (anglais et français) : tableau des versions à jour.

## 2026-10-18 — `@astratra/models` 1.2.0 : Whisper small par défaut pour la transcription

Choix d'Emch pour la dictée (comme Tertius le 28/09/2026) : Whisper small fait environ 13,6 % de mots faux en français, contre 25 % pour base.

### Modifié
- `transcribe` est maintenant `Systran/faster-whisper-small` (révision `536b0662`, `model.bin` de 484 Mo, MIT), dossier `faster-whisper-small`, `id` annoncé `faster-whisper-small` dans `/health` et les réponses. Environ 1,2 s par phrase contre 0,35 s pour base sur un processeur de portable.
- Un service installé avant 1.2.0, qui n'a que `faster-whisper-base`, le garde et l'annonce jusqu'au prochain `astratra-models fetch`, au lieu de ne plus rien charger.

### Ajouté
- `transcribe_base` (Whisper base, révision inchangée) dans le manifeste, marqué `optional` : téléchargé seulement nommé (`fetch --models transcribe_base`), puis `MODELS_TRANSCRIBE_PATH` vers son dossier pour rester sur base. Un modèle `optional` n'est jamais pris par défaut (`fetch`, `--check`) ; `list` le signale.
- `scripts/build-manifest.js` : un dépôt déjà figé garde sa révision même sous un autre nom de modèle.

### Documentation
- README du paquet et du service, notice des modèles ; README (anglais et français) : tableau des versions à jour.

## 2026-10-18 — `@astratra/ai` 1.12.0, `@astratra/centrale` 1.7.0 : signatures de pensée de Gemini 3

Le 18/10/2026, tous les tours d'outils de Boutique Roro sur Gemini 3 (par la passerelle Centrale) étaient refusés (400) : Gemini 3 exige que la signature de pensée de chaque appel d'outil lui revienne au tour suivant.

### Corrigé
- `@astratra/ai` : un appel d'outil garde sa signature (`toolCalls[i].signature`), lue chez Gemini (`thoughtSignature`) et au format OpenAI (`extra_content.google.thought_signature`, réponse entière ou en flux) ; elle repart avec l'appel dans l'historique. Chez Gemini, un premier appel sans signature part avec la valeur de contournement de Google (`skip_thought_signature_validator`), sauf pour Gemma.

### Ajouté
- `@astratra/ai` : option `thoughtSignatures` (cible d'`askChatModel`, options de `createOpenAICompatibleProvider`) : au format OpenAI, la signature n'est envoyée qu'à `*.googleapis.com` par défaut, jamais à un autre fournisseur ; `true` pour une passerelle qui la relaie.
- `@astratra/centrale` : `modeleDiscussion()` rend `thoughtSignatures: true` (la passerelle relaie les signatures).

### Modifié
- README (anglais et français) : tableau des versions à jour.

## 2026-10-17 — `@astratra/agent` 1.3.0, `@astratra/conscience` 1.4.0 : réglages à chaud, entrée corrigée à l'approbation, file sur sa propre table, budget en lecture seule

Manques relevés en branchant l'assistant de Boutique Roro sur ces deux paquets.

### Ajouté
- `@astratra/agent` : intervalle aligné `{ type: 'interval', everyMs, align: true }` (marques rondes de la journée locale, comptées depuis minuit local, changement d'heure compris ; `everyMs` en secondes entières, un jour au plus).
- `@astratra/agent` : `enabled` et `schedule` d'une tâche acceptent une fonction (éventuellement asynchrone) relue à chaque passage ; une tâche coupée n'a plus de prochain passage, une programmation changée est replanifiée (`'rescheduled'`) ; un état enregistré avant cette version garde son plan. `state()` montre `enabled` et `schedule` en vigueur.
- `@astratra/agent` : `approve(id, { decider, input })`, l'action telle que la personne l'a corrigée : vérifiée par `validateInput` (option), enregistrée en `decisionInput` dans la même réservation atomique avant toute exécution, donnée à l'exécuteur en `input` (la proposition reste en `proposedInput`), effacée par un refus. Un stockage maison qui ne garde pas `decisionInput` est refusé sans rien exécuter.
- `@astratra/agent` : `createPostgresApprovalStore(db, { table, columns, statuses, scope })` sur une table existante (noms de colonnes, mots de statut, `scope` pour une table qui contient aussi d'autres actions, colonnes facultatives à `null`) ; `postgresApprovalSchema()` ajoute la colonne `decision_input` à une table plus ancienne. Contrat d'un stockage maison documenté (create/get/list/reserve/finish/revert/reject/expire).
- `@astratra/conscience` : `overThreshold(input, settings, { organisationId, actor })` et `validate` peuvent être asynchrones (seuil lu en base ; une erreur ou un rejet met l'appel en attente d'une personne).
- `@astratra/conscience` : option `isHalted` de `createToolPolicy` (booléen ou fonction par organisation, éventuellement asynchrone), un arrêt d'urgence tenu par l'application, lu avant chaque appel et pendant l'exécution ; toute autre valeur refuse l'appel (`settings_unavailable`).
- `@astratra/conscience` : `createCalendarBudget` sur un magasin qui n'a que `getSpent()` (consommation comptée ailleurs) : `readOnly: true`, `record()` et `recordSpend()` lèvent `budget_read_only`.

### Modifié
- README (anglais et français) : tableau des versions à jour.

## 2026-10-17 — `@astratra/shipping` 1.1.0 : réglages relus à chaque appel, heures en millisecondes, purge du journal

Manques relevés en branchant Boutique Roro sur la 1.0.0.

### Ajouté
- `createSendcloudCarrier` : `sender` et `testMode` acceptent une valeur ou une fonction (éventuellement asynchrone) relue à chaque appel, comme les clés : l'adresse d'expédition et le mode test changent sans recréer le transporteur. `carrier.testMode` vaut le booléen donné, ou `null` pour une fonction (`status().testMode` donne la valeur du moment).
- `createCarrierWebhook` : purge de la trace des notifications quand le journal sait purger (`createPostgresEventLog`) : événements traités de plus de 90 jours effacés au plus une fois par jour, après la réponse et jamais sur son chemin (`pruneOlderThanMs`, `false` pour désactiver ; `pruneEveryMs` ; `settled()` attend une purge en cours ; un échec est journalisé, jamais renvoyé à Sendcloud).
- `toMilliseconds(valeur)` exporté.

### Corrigé
- `timestamp` des événements : toujours en millisecondes (secondes, millisecondes, chaîne numérique ou date ISO ramenées en millisecondes ; nul, négatif ou illisible : `null`). Le README annonçait des secondes et les tests utilisaient des millisecondes : une comparaison « un statut ancien n'écrase pas un récent » est maintenant sûre.

### Documentation
- `downloadLabel` : pas de « commencer à la case N » sur une planche A4, l'API v3 de Sendcloud ne le propose pas. Exemple SQL pour ne garder que le statut le plus récent.

## 2026-10-17 — `@astratra/shipping` 1.0.0, `@astratra/payments` 1.1.0, `create-astratra-app` 1.11.2 : étiquettes d'expédition, journal d'événements PostgreSQL

### Ajouté
- `@astratra/shipping` 1.0.0, nouveau paquet, tiré du code des transporteurs de Boutique Roro et rendu générique : contrat `Carrier` (options d'expédition, annonce de l'envoi et étiquette, téléchargement, annulation, points relais, signature, lecture des événements) et adaptateur Sendcloud **API v3** `createSendcloudCarrier` (la v2 passe en maintenance chez Sendcloud) : options d'expédition par codes stables, étiquette rendue avec l'envoi, `reference` (`external_reference_id`) contre le double achat, annulation par envoi, points relais `/service-points` ; clés en option (valeur ou fonction relue à chaque appel), clé de signature des webhooks dédiée, expéditeur enregistré ou complet, `fetch` injectable, disjoncteur et relances de `@astratra/resilience` sur les seules lectures, un 4xx n'est pas une panne ; correspondance des statuts de suivi (`classifySendcloudStatus`) ; erreurs `ShippingError` à code stable, sans corps ni clé, phrases fr/en par `messageFor` (catalogue de `@astratra/i18n-server`) ; mode test `sendcloud:letter` ; `createCarrierWebhook` sur le tuyau de `@astratra/payments` (signature HMAC-SHA256 du corps brut en temps constant, identifiant = empreinte SHA-256 du corps, réservation atomique, libération en cas d'échec, `timestamp` pour l'ordre des événements). Tests sans réseau (faux Sendcloud v3), README en/fr, types.
- `@astratra/payments` 1.1.0 : `createPostgresEventLog(pool, { table, claimTtlMs })` et `postgresEventLogSchema()`, le journal des événements partagé par toutes les instances (même contrat que le journal en mémoire : réservation atomique par `INSERT … ON CONFLICT`, expiration d'une réservation inachevée, `release` qui n'annule jamais un événement traité), plus `prune(olderThanMs)` ; sans dépendance à `pg`. Contrat de tests commun aux deux journaux, joué sur une vraie base avec `PAYMENTS_TEST_DATABASE_URL`.

### Modifié
- `create-astratra-app` 1.11.2 : les projets générés avec la brique paiements demandent `@astratra/payments` ^1.1.0.
- README (anglais et français) : 45 paquets, tableau des versions à jour.

## 2026-10-16 — `@astratra/conscience` 1.3.0 : politique d'outils, budget calendaire, arrêt d'urgence des outils

### Ajouté
- `@astratra/conscience/governor` : `createToolPolicy`, la décision par code d'**un appel d'outil** (hors modèle, générique : familles, niveaux, plafonds et vocabulaire viennent de la configuration). Chaque outil déclare une famille, un niveau (`TOOL_LEVELS` : `read`, `controlled`, `sensitive`) et des plafonds facultatifs (`maxPerRun`, `overThreshold`, `estimatedCost`) ; un appel est `allowed`, `refused` (`TOOL_REASONS` : `emergency_stop`, `disabled`, `unknown_tool`, `family_disabled`, `invalid_input`, `budget_exceeded`, `cap_reached`, `settings_unavailable`) ou `pending` (outil sensible, hors plafond, ou contexte non fiable signalé par l'appelant après une lecture web). Réglages relus avant chaque appel ; tout ce qui est illisible refuse. Mots renommables (`labels`). `execute` n'exécute que les appels autorisés. `availableTools` donne les outils à offrir au modèle.
- `createCalendarBudget`, `calendarPeriodKey`, `createMemoryToolBudgetStore`, `createPostgresToolBudgetStore`, `postgresToolBudgetSchema` : budget compté par mois civil ou par jour dans un fuseau horaire (période personnalisable), montants et plafond en entiers, test de dépassement avant chaque appel, consommation idempotente par identifiant ; PostgreSQL en une seule requête atomique. Interface de magasin documentée pour d'autres bases (pas de magasin MongoDB pour ce budget).
- Arrêt d'urgence applicable aux outils : interrupteur lu avant chaque appel, `AbortSignal` qui coupe un outil en cours (aussitôt dans le processus, au plus tard à `pollMs` pour un arrêt tiré ailleurs, et appel abandonné même si l'outil ignore le signal) ; activation par `emergency.activateRoles`, levée par `emergency.releaseRoles` (un acteur `model` ou `engine` ne lève jamais) ; l'interrupteur du gouverneur arrête aussi les outils (option `governor`).
- Audit : chaque décision (`tool_decision`), issue (`tool_outcome`), arrêt et reprise (et leurs refus) est écrit dans le journal du gouverneur avant d'être rendu, avec l'empreinte de l'entrée et jamais l'entrée brute ; sans journal écrit, l'outil ne s'exécute pas.
- Types, tests (politique, budget à cheval sur deux mois dans deux fuseaux, arrêt d'urgence d'un outil lent, audit, contrat de magasin joué sur la mémoire et PostgreSQL réel), README anglais et français.


## 2026-10-16 — `@astratra/centrale` 1.6.0 : journal des agents

### Ajouté
- Entrée `/agents` : `creerJournalAgents({ adresse, cle, fetch? })` envoie les exécutions d'une IA à `POST /v1/agents` (lots de 100 au plus, clé publique du projet). Validation locale (clé inconnue, statut, type d'étape ou état d'action hors liste refusés ; bornes du format ; dates à la seconde), masquage des textes, file en mémoire avec recul progressif (`Retry-After` respecté), abandon silencieux d'un lot refusé en 4xx, ne lève jamais.
- `construireExecution(bilan, { inclureContenu? })` : une exécution générique (tours de modèle, appels d'outils, actions, jetons, coût, statut, code d'erreur) **sans** question, réponse, arguments ni résultats par défaut ; option explicite pour les joindre.
- `transportFetch(delaiMs, fetch?)` accepte un `fetch` à injecter. Tests.

## 2026-10-16 — `@astratra/agent` 1.2.0 : ordonnanceur de tâches et file d'actions en attente d'approbation

### Ajouté
- `createScheduler` : tâches programmées à heure fixe (`daily`, `weekly` jour(s) + heure, `interval`) dans un fuseau IANA, changements d'heure gérés (une heure inexistante part après le trou, une heure double part une fois). Un verrou injectable par tâche (`createMemoryLock`, `createPostgresLock` sur `pg_try_advisory_lock`) empêche deux passages en parallèle, l'état étant relu sous le verrou. Passages manqués sautés au-delà de `maxLateMs`. Arrêt global `shouldStop` consulté avant et pendant le passage (`AbortSignal` transmis à la tâche), `abortAll()`, lancement manuel `run(id)`, état lisible `state()` (dernier passage, prochain, statut, résultat, erreur), `start()` / `stop()` explicites (jamais au chargement du module), horloge `now` injectable. Stockage de l'état : `createMemoryScheduleStore`, `createPostgresScheduleStore` + `postgresScheduleSchema`. `nextRun` et `zonedTime` exportées.
- `createApprovalQueue` : file d'actions proposées (type, entrée, demandeur, expiration) décidées plus tard par une personne authentifiée par l'appelant (`authorize` facultatif). `approve` réserve l'action de façon atomique puis lance l'exécuteur fourni : une seule exécution même en concurrence, résultat enregistré, `idempotencyKey` transmise ; un refus (`ApprovalRefused`) ou une erreur de l'exécuteur remet l'action en attente avec la raison. `reject`, `list`, `expire` (aussi appelée à chaque opération), `beforeExecute` (dernier contrôle), `onEvent`. Stockage : `createMemoryApprovalStore`, `createPostgresApprovalStore` + `postgresApprovalSchema` (chaque transition est un `UPDATE` conditionnel). Erreurs `ApprovalError` (`not_found`, `expired`, `already_decided`, `forbidden`, `no_executor`, `execution_failed`, `invalid`).
- Tests (fuseau et changement d'heure, verrou concurrent, passage manqué, arrêt pendant une tâche, approbations concurrentes, expiration, refus de l'exécuteur, PostgreSQL réel), types et `typecheck.ts`, README français et anglais.

## 2026-10-16 — correctifs : `@astratra/payments` 1.0.1, `@astratra/flags` 1.0.2, `@astratra/prerender` 1.0.1, `@astratra/privacy` 1.0.1, `@astratra/saas-kit` 2.0.1, `@astratra/repomap` 1.0.1, `@astratra/voice` 1.1.1, `create-astratra-app` 1.11.1

### Sécurité
- `payments` 1.0.1 : la protection contre les rejeux est atomique. L'ancien enchaînement `seen()` puis `record()` après le handler laissait passer deux livraisons simultanées du même événement (commande confirmée deux fois). L'événement est désormais réservé avant le traitement (`claim(id)`, faux s'il est déjà traité ou en cours → 200 `duplicate`), libéré si le handler lève ou si l'événement n'est pas le nôtre (`release(id)`), confirmé par `record()`. `createMemoryEventLog` implémente `claim`/`release`, avec une réservation qui expire (`claimTtlMs`, 15 min) pour qu'un processus planté ne bloque pas l'événement. Un type sans handler ne prend plus de réservation. Un ancien journal `{ seen, record }` est encore accepté, avec un avertissement (non atomique) ; un journal sans l'un ni l'autre est refusé à la création. README (exemple complet qui définit `eventLog`, tableau des réponses, exemple SQL `INSERT … ON CONFLICT`) et types (`EventLog`, `LegacyEventLog`) à jour. Tests (livraisons simultanées, libération après échec, compatibilité).

### Corrigé
- `flags` 1.0.2 : un drapeau absent renvoie la valeur par défaut de l'appelant (`resolveBoolean('absent', true)` → `true`, raison `FLAG_NOT_FOUND`) ; il renvoyait `false` quoi qu'on passe. Test.
- `prerender` 1.0.1 : les URL du sitemap sont échappées en XML (`&` d'une URL avec paramètres rendait le fichier invalide), comme `lastmod`, `changefreq` et `priority` ; un `label` ne peut plus refermer son commentaire ; l'audit relit les URL échappées comme les chemins d'origine. Tests.
- `prerender` 1.0.1 : `apiPatterns: false` coupe le remplacement des appels API par `{}` (il levait « not iterable ») ; quand le défaut `['**/api/**']` n'a pas été demandé et qu'il a remplacé des appels, `warnings` le dit page par page (une fiche produit dont le contenu vient de l'API serait capturée vide). La CLI `astratra-prerender` affiche désormais ces avertissements sur la sortie d'erreur (préfixe `[astratra-prerender]`, sans faire échouer le build) : avant, seul un appel programmatique pouvait les lire. README : avertissement dédié et valeur de retour `{ pages, warnings, sitemap }`. Tests d'intégration.
- `repomap` 1.0.1 : les tests passent sans `--experimental-vm-modules` (`npx jest` échouait sur 9 tests sur 11) : web-tree-sitter est chargé par sa version CommonJS et la grammaire lui est passée en octets, sans `import()` dynamique. Le script de test n'a plus besoin de `NODE_OPTIONS`.
- `saas-kit` 2.0.1 : `@astratra/ai` retiré des dépendances, jamais chargé par `src` (les projets de `create-astratra-app` le déclarent eux-mêmes). Test : chaque dépendance déclarée est chargée.

### Documentation
- `privacy` 1.0.1 : le README et le contrat `runConsentStoreContract` ne laissent plus croire qu'un `createMongoConsentStore` est fourni : seul le store mémoire l'est, l'adaptateur d'une vraie base est à écrire selon le contrat.
- `voice` 1.1.1 : le README dit, dès la présentation du moteur `sherpa`, qu'il n'a été testé qu'avec des doublures et jamais avec un vrai modèle sherpa-onnx.
- README (anglais et français) : tableau des versions à jour.

### Modifié
- `create-astratra-app` 1.11.1 : les projets générés demandent les versions que l'espace de travail publie : `@astratra/payments` ^1.0.1 (rejeux atomiques), `@astratra/privacy` ^1.0.1, `@astratra/saas-kit` ^2.0.1, `@astratra/prerender` ^1.0.1, et `@astratra/ai` ^1.11.0, `@astratra/security` ^1.13.0, `@astratra/notify` ^1.1.0 (ces trois planchers n'avaient pas suivi la livraison du 11/10 : 4 tests de cohérence échouaient). La brique `payments` générée rappelle que le journal en mémoire ne sert qu'au développement (en production : un store partagé avec claim / release / record). Le test de cohérence des briques couvre aussi le modèle fullstack, seul à accepter les briques navigateur (le plancher de `prerender` dérivait sans être vu).

## 2026-10-15 — `@astratra/centrale` 1.5.0 : moins de fausses alertes

### Modifié
- Navigateur : un navigateur piloté par un robot (`navigator.webdriver` : Playwright, Selenium, Puppeteer) ne collecte rien, sauf option `robots: true` (57 fausses erreurs venaient des tests Playwright d'une app).
- Gardien du fil principal : un retard de la minuterie de plus de 60 s est une pause de l'app (téléphone verrouillé, onglet endormi), pas un blocage : seulement une miette, sans `AppBloquee` (option `plafondMs` de `surveillerBlocages`) ; sur Expo, l'état `inactive` met aussi le gardien en pause (59 « blocages » sur iPhone, jusqu'à 2 181 s).
- Requêtes `fetch` : les vérifications de connexion (`generate_204`, `captive.apple.com`, `msftconnecttest.com`, `detectportal.firefox.com`…) restent dans le fil d'Ariane mais ne sont plus signalées (`estVerificationDeConnexion`, 83 fausses erreurs).
- `VERSION_SDK` passe à 1.5.0 (il était resté à 1.4.0) ; un test vérifie qu'il suit la version du paquet.
- Nouveau `packages/centrale/CHANGELOG.md` (publié avec le paquet) ; README français et anglais à jour ; tableau des versions de la racine à jour.

## 2026-10-11 — `@astratra/notify` 1.1.0, `@astratra/ai` 1.11.0, `@astratra/security` 1.13.0 : ce qu'il manquait à Palabre

### Ajouté
- `@astratra/notify` 1.1.0 : `createApnsTransport`, les notifications Apple en direct (HTTP/2, jeton de fournisseur ES256 gardé 50 minutes, une seule connexion réutilisée). Transport prêt pour `createPushSender` : un appareil mort (410, `BadDeviceToken`, `Unregistered`) est rendu pour suppression. Badge, notification urgente (`time-sensitive`), notification silencieuse ; clé `.p8` acceptée sur une seule ligne. Repris du code de Centrale LJ, vérifié en vrai sur iPhone et Mac le 11/10/2026.
- `@astratra/ai` 1.11.0 : les gardes reconnaissent les secrets — clés d'API (OpenAI, Anthropic, Google, GitHub, Stripe, AWS, Slack, Groq, Hugging Face), jetons JWT, clés privées — et les adresses IP (v4, v6). Masqués à l'entrée, signalés en fuite à la sortie quand la personne ne les a pas donnés. Nouveaux types de `findPersonalData` : `apiKey`, `jwt`, `privateKey`, `ip` ; une clé ou une adresse n'est jamais lue à moitié comme un téléphone ou une carte.
- `@astratra/security` 1.13.0 : `createDeviceSignatureVerifier`, des requêtes signées par la puce du téléphone (Secure Enclave), pour une app sans écran de connexion qui ne répond qu'aux appareils connus. Clé d'appareil et clé Face ID (P-256), signature de la méthode, du chemin, de l'heure, d'un nonce et du corps ; nonce à usage unique, décalage horaire borné, enregistrement prouvant la possession des clés, appareil unique (`maxDevices: 1`), révocation, même réponse à chaque refus. `createMemoryDeviceStore` pour le développement ; exemple Swift dans le README.

## 2026-10-11 — `@astratra/saas-kit` 2.0.0, `@astratra/saas-kit-ui` 1.4.0, `create-astratra-app` 1.11.0, `@astratra/security` 1.12.1 : failles de comptes corrigées

### Rupture
- `saas-kit` 2.0.0 : les deux comptes d'exemple du store mémoire (`createMemoryUsersStore()` sans `users`, et `createSaasApp` sans `usersStore`) n'ont plus aucun identifiant : le mot de passe en clair `password` est retiré, plus personne ne s'y connecte. Fournir ses comptes avec une empreinte (`passwordHash: await hashPassword(...)`) et `verifyPassword: (user, p) => verifyPasswordHash(p, user.passwordHash)`. Les tests du kit suivent la même règle (empreinte scrypt, plus aucune comparaison en clair).

### Sécurité
- `saas-kit` : `POST` et `PATCH /users` n'écrivent plus le corps de la requête tel quel (affectation de masse). Seuls les champs de `writableUserFields` passent (par défaut `email`, `role`, `name`) ; `id`, `password`, `passwordHash`, `hash`, `salt` et les jetons sont toujours ignorés.
- `saas-kit` : un administrateur ne peut plus se donner, ni donner, un rôle d'administrateur ou de propriétaire, ni modifier le compte d'un autre administrateur ; c'est réservé à `roles.ownerRoles` (par défaut `['owner']`). Le rôle de l'appelant est relu dans le store : une rétrogradation s'applique aussitôt.
- `saas-kit-ui` : chaque écran déclare qui peut le voir (`VIEW_ACCESS`) ; un membre ne voit plus que le tableau de bord, et un écran interdit n'est jamais rendu, même demandé. Le formulaire « Utilisateurs » ne propose les rôles d'administration qu'à un propriétaire et n'envoie plus de mot de passe pré-rempli (`password`). Nouveaux exports : `canSeeView`, `visibleViews`, `assignableRoles`, `VIEW_ACCESS`, `DEFAULT_ADMIN_ROLES`, `DEFAULT_OWNER_ROLES` ; `AstratraDashboardApp` accepte `adminRoles`.
- `create-astratra-app` : l'API générée ne compare plus les mots de passe en clair (`verifyPasswordHash` sur `user.passwordHash`). Les comptes de démonstration n'ont plus le mot de passe fixe `password` : il est tiré au hasard à chaque démarrage, 12 caractères (ou `DEMO_PASSWORD`), gardé seulement en empreinte scrypt, affiché dans la console ; les stores en mémoire refusent de démarrer en production.

### Modifié
- `@astratra/security` 1.12.1 : erreur de lint corrigée dans `idTokens.js` (`AbortSignal` lu sur `globalThis`), sans changement de comportement. La longueur minimale d'un mot de passe reste de 8 caractères.
- README (anglais et français) : tableau des versions réaligné sur les paquets du dépôt (dix paquets y étaient en retard).
- `create-astratra-app` : planchers des dépendances alignés sur l'espace de travail (`@astratra/ai` ^1.10.0, `@astratra/security` ^1.12.1, `@astratra/saas-kit` ^2.0.0, `@astratra/saas-kit-ui` ^1.4.0) ; trois tests de cohérence échouaient avant.
## 2026-10-10 — `@astratra/resilience` 1.1.0 : connexions gardées ouvertes

### Ajouté
- `createKeepAliveFetch` : un fetch (undici) dont les connexions restent ouvertes 4 min (réglable) au lieu des 4 s de Node, pour qu'un appel espacé ne refasse pas la poignée de main TLS ; une demande partie sur une connexion fermée par l'autre côté est refaite une fois (jamais un corps en flux ni une demande annulée) ; `close()`. `isStaleConnection`. Dépendance : `undici`. Tests (même connexion après 5 s, relance unique).

## 2026-10-10 — `@astratra/agent` 1.1.0 : montrer une réponse pendant qu'elle s'écrit

### Ajouté
- Avec des gardes, `turn` reçoit `unmask(texte)` : les vrais mots d'un texte du modèle, pour montrer une réponse en flux (`onText` de `@astratra/ai` 1.10.0) sans ses repères de masquage. La réponse finale passe toujours par la garde de sortie ; la requête envoyée au modèle reste masquée. Tests.

## 2026-10-10 — `@astratra/ai` 1.10.0 : la réponse petit à petit

### Ajouté
- `onText` (contexte de `route()`, ou `io` d'`askChatModel` et `askGeminiModel`) : la réponse est demandée en flux (`stream` au format OpenAI, `streamGenerateContent` chez Gemini) et le texte montrable entier est rendu à chaque avancée, sans réflexion, sans balise coupée, sans appel d'outil écrit ; il repart de zéro au modèle suivant ; la valeur rendue ne change pas. Jamais passé à un fournisseur masqué.
- `visibleSoFar`, `readServerEvents`, `textReporter` ; tests (OpenAI, appels d'outils en morceaux, Gemini avec sources, routeur).

## 2026-10-10 — `@astratra/conscience` 1.2.0 : magasins MongoDB

### Ajouté
- `createMongoGovernorStore` : propositions idempotentes, comparaison atomique des approbations et révisions, objets versionnés, contrôles, constats et journal d'audit ordonné. Budgets réservés sous verrou d'organisation dans une transaction MongoDB (replica set ou cluster shardé obligatoire).
- `createMongoConscienceStore` : records idempotents, filtres et ordre stable, remplacement et suppression pour rétention et effacement des personnes ; même contrat que PostgreSQL et la mémoire.
- `mongoGovernorIndexes` et `mongoConscienceIndexes` : migrations explicites idempotentes avec préfixes de collections configurables. Pilote `mongodb` en peerDependency optionnelle, jamais importé par les magasins ; `Db` natif injectable, y compris depuis mongoose.
- Types et documentation française et anglaise ; mêmes suites de contrat sur faux client et MongoDB réel optionnel via `MONGO_TEST_URL`, plus courses concurrentes entre connexions indépendantes.

## 2026-10-10 — `@astratra/native-ui` 1.2.0 et `@astratra/saas-kit-ui` 1.3.0 : pouces dessinés

### Modifié
- `FeedbackBar` (mobile et web) : les pouces sont des icônes vectorielles, plus jamais des émojis (👍/👎 changeaient d'aspect selon le système). Un même contour sur une grille de 24, retourné pour le pouce en bas, plein une fois choisi ; couleur du texte, puis blanc (mobile) ou `--lime` (web) quand il est choisi. `icons` remplace toujours ce dessin.
- `native-ui` : `react-native-svg` (>= 15) devient une dépendance facultative ; sans elle, un simple triangle, jamais un émoji.
- Tests : aucun émoji rendu, pouce choisi plein, pouce en bas retourné, icônes de l'app respectées.

## 2026-10-10 — `@astratra/centrale` 1.4.0 : recherche récente par la passerelle

### Ajouté
- `rechercher` : option `periode` (`heure`, `jour`, `semaine`, `mois`, `an`) pour des résultats récents ; la réponse porte l'encadré de réponse (`encadre`) et la fiche (`fiche`) de Google, et chaque résultat sa `date` et ses sous-liens (`liens`) quand Google les donne. Types `PeriodeRecherche`, `ReponseRecherche` ; tests.

## 2026-10-10 — `@astratra/centrale` 1.3.0 : client de la passerelle des clés

### Ajouté
- Entrée `/passerelle` : `lirePasserelle(env)` (`CENTRALE_ADRESSE`, `CENTRALE_PASSERELLE_JETON`, jeton `clj_pas_…` vérifié, HTTPS hors boucle locale), `modeleDiscussion(p)` (modèle `auto` au format OpenAI, à mettre en tête du relais d'une IA), `plongements`, `rechercher`, `voix`, et `passerelleDabord` (la passerelle d'abord, les clés directes seulement en cas de panne).
- `PasserelleIndisponible` (injoignable, délai, 5xx, 429, 401/403, 503) et `RequetePasserelleRefusee` (400, 413, sans repli) ; tests.

## 2026-10-10 — `@astratra/centrale` 1.2.0 : surveillance renforcée

### Ajouté
- Nouvelle entrée `/vigilance` (aussi exportée par la racine), branchée par défaut dans `/navigateur` et `/expo` : requêtes `fetch` dans le fil d'Ariane (gabarit, statut, durée) et signalées quand elles échouent (`RequeteSansReponse`, `RequeteEchouee`) ; `console.error` signalé, `console.warn` dans le fil d'Ariane ; gardien du fil principal (`AppBloquee`).
- Expo : promesses rejetées sans `catch` (Hermes), alerte mémoire d'iOS (`MemoireSaturee`), premier plan, arrière-plan et lancement dans le fil d'Ariane ; option `stockage` pour garder l'état entre deux lancements : session restée ouverte close « anormale » ou « plantage », fermeture au premier plan signalée (`FermetureInattendue`) avec le fil d'Ariane et l'écran.
- Navigateur : mêmes capteurs ; `stockage` facultatif (un seul onglet).
- Cœur : `filAriane()`, `sessionPrecedente(id, etat)`, option `filAriane` des erreurs. `VERSION_SDK` passe à 1.2.0.
- Options `requetes`, `console`, `blocages`, `promesses` (vraies par défaut) ; tests.

## 2026-10-10 — `AstratraCentrale` 1.1.0 (Swift) : surveillance renforcée

### Ajouté
- Dernier état gardé sur le disque au fil de l'eau (fil d'Ariane, mémoire occupée et la plus haute, blocage en cours) : une fermeture au premier plan (`FermetureInattendue`) ou pendant un blocage (`FermeturePendantBlocage`) part au lancement suivant avec ce fil d'Ariane, l'écran et la mémoire.
- Gardien du fil principal : interface bloquée plus de 2 s signalée (`AppBloquee`, erreur au-delà de 5 s), début du blocage noté sur le disque tant qu'il dure.
- Appareil : mémoire saturée (`MemoireSaturee`), surchauffe critique (`Surchauffe`) ; température, économie d'énergie, premier plan et arrière-plan dans le fil d'Ariane.
- MetricKit : blocages, excès de processeur et d'écriture disque, lancements lents (iOS), avec la pile ; rapport quotidien des fermetures par raison (`rapport_apple`) et `FermeturesSysteme` pour les fermetures forcées.
- Chaque erreur porte `memoire_mo` ; chaque écran entre dans le fil d'Ariane ; hors mode strict, `Appareil.decrire()` remplit le contexte (modèle et mémoire).
- Tests.

## 2026-10-10 — `AstratraCentrale` 1.0.0 (Swift, nouveau paquet)

### Ajouté
- Paquet Swift de collecte pour iOS 17 et macOS 14 (`Package.swift` à la racine, sources dans `swift/`), même format d'envoi que `@astratra/centrale` (version 1) : erreurs Swift avec leur pile, messages, écrans (gabarit), usages, sessions et appels d'IA (champs fixes, jamais de contenu).
- File bornée (les usages sont jetés avant les erreurs), envoi par lots de même contexte sous 100 événements et 1 Mo, reprise avec recul sur 5xx, 408, 429 (`Retry-After`) et hors ligne, abandon sur les autres 4xx.
- Masquage avant l'envoi (mêmes règles que `@astratra/centrale/masquage`), mode strict par défaut, désactivé sans clé ni adresse.
- `suivreApplication()` : sessions (début, fin après 30 s en arrière-plan ou à la fermeture), vidage en arrière-plan, exceptions Objective-C gardées sur le disque et envoyées au lancement suivant avec la session « plantage » ; une session restée ouverte devient « anormale ».
- Tests (faux transport) ; les corps produits ont été vérifiés contre la validation du backend.

## 2026-10-09 — `@astratra/ai` 1.9.0 : recherche Google intégrée de Gemini

### Ajouté
- `googleSearch` sur une requête Gemini : l'outil `google_search` part avec la requête. Avec les fonctions de l'application, `functions: 'combine'` (ensemble), `'alone'` (la recherche seule pour ce tour) ou `'auto'` (défaut : ensemble, puis la recherche seule si l'API refuse le mélange, `functionsDropped: true`). Ignoré par les fournisseurs au format OpenAI.
- Réponse : `grounding` (`searched`, `queries`, `sources: [{ title, url }]`, `searchSuggestionsHtml`, `functionsDropped`), transmis au routeur par les fournisseurs `detailed`. `readGeminiGrounding` lit une réponse brute. Les pages sont des données non fiables : titres d'une ligne bornés, adresses `http(s)` sans identifiants, dédoublonnées et bornées ; rien n'est relu comme une consigne.
- Types (`GoogleSearchOption`, `GeminiGrounding`, `GroundingSource`), README français et anglais, tests sur faux transport.

## 2026-10-09 — `@astratra/centrale` 1.1.0 : client de la conscience d'une IA

### Ajouté
- Nouvelle entrée `@astratra/centrale/conscience` : `creerConscienceCentrale({ adresse, jeton })`, client léger des routes « conscience » du tableau de bord, authentifié par le jeton de projet. `lireReglages()` garde les réglages avec leur ETag (`If-None-Match`, un 304 rend la copie) ; `envoyerBilan(rapport, propositions?)` envoie le bilan du matin d'un gouverneur et la liste complète des propositions en attente ; `lireDecisions()` rend les décisions humaines pas encore accusées ; `accuserDecision` / `accuserDecisions` disent ce que le gouverneur en a fait (`failed` n'est pas accusé et revient au passage suivant). Erreurs `ErreurConscience` (statut HTTP ou `null` hors ligne, code).
- `resumerBilan` et `nettoyerMesures` : le bilan est réduit à des identifiants, des codes et des nombres avant l'envoi (ni question, ni réponse, ni note, ni identifiant de décision, ni objet `tests`, ni plan de retour arrière, ni identité d'une personne ; toute chaîne que le masquage changerait est retirée).
- Toujours sans dépendance ni autre paquet Astratra (vérifié par test). README anglais (`README.en.md`, publié) ; types ; tests.

## 2026-10-09 — `@astratra/conscience` 1.1.0 : réglages distants

### Ajouté
- `@astratra/conscience/governor` : `createRemoteSettings`, adaptateur générique « réglages distants ». Un tableau de bord allume ou éteint l'agent, tire ou lève son arrêt d'urgence, nomme ses approbateurs, règle sa réflexion (heure, fuseau, cycles par jour) ; l'adaptateur en fait des options du gouverneur (`policy()`, `governor()` refait quand la politique change) et soumet les décisions humaines par `approveProposal` / `declineProposal` (`applyDecisions`, rejouable : `already_applied`). Aucune dépendance : la lecture des réglages est une fonction passée par l'application.
- Règles déterministes : source muette ou invalide, le dernier réglage valide reste (mémoire ou `storage`) ; aucun réglage connu, tout est éteint (gouverneur arrêté, aucun approbateur) ; version plus ancienne ignorée ; `halted: true` appliqué aussitôt, même dans une réponse invalide, et `sync` tire l'arrêt d'urgence du gouverneur ; un arrêt n'est relâché que s'il a été tiré par l'adaptateur, au nom de l'humain de `resumedBy`. Un réglage distant ne touche jamais la constitution, les portées protégées, les permissions, la matrice d'approbations ni les budgets au-delà des plafonds locaux (champs listés dans `ignored`).
- `parseRemoteSettings`, `remotePolicy`, `reflectionDue`, `reflectionCycleId` (un cycle idempotent par jour local) ; types, README anglais et français ; tests (rejeu d'une approbation, source en panne, réglage hostile, arrêt et reprise). Le gouverneur n'importe toujours que les modules de Node (test du graphe d'imports inchangé).

## 2026-10-09 — contrats et intégrations

### Ajouté
- `@astratra/saas-kit-ui` 1.2.0 : déclarations TypeScript complètes du tableau de bord, de l'API et de FeedbackBar avec ses règles ; vérification de compilation à la racine.
- Tests réels optionnels Redis et MongoDB pour security, resilience et credentials ; tests HTTP de flags et HTTP/WebSocket de live, avec coupures et expiration. Les tests ne sont pas publiés : versions de live, resilience et credentials inchangées.
- `create-astratra-app` 1.10.0 : planchers security ^1.11.1 et saas-kit-ui ^1.2.0.

### Corrigé
- `@astratra/security` 1.11.1 : types des constantes DEFAULT_PERMISSIONS_POLICY et DEFAULT_CSRF_COOKIE_NAME.
- `@astratra/flags` 1.0.1 : nouvelle version pour distribuer le README neutre déjà présent dans le dépôt.

## 2026-10-09 — `@astratra/conscience` 1.0.0 (nouveau paquet)

### Ajouté
- `@astratra/conscience/autoconscience` (P3 · expériences, première moitié : 02/35, 32, 36, 16) : `replayDecisions` reconstruit les informations disponibles à chaque décision et refuse les données futures (`future_data`), avec compatibilité seulement et aucune preuve de progrès ; `createSandbox` remplace tous les outils réels par des réponses simulées et des intentions d'écriture journalisées ; `createHoldout` protège les entrées/réponses finales, journalise les accès refusés (`holdout_protected`) et ne rend qu'un score agrégé à usage unique ; `proposeExperiment` fige hypothèse, métriques, protocole et seuils pré-enregistrés avec date et empreintes ; `runExperiment` exécute développement, validation puis holdout, refuse toute modification (`protocol_changed`) et rend Wilson de P2 avec décision non concluante possible. Fonctions candidates isolées, sans transport réseau ni accès aux fonctions réelles ; jugements déterministes sans modèle de langage. Audit par les constats du gouverneur mémoire/PostgreSQL, types et documentation bilingue ; tests réels PostgreSQL, protections, concurrence et preuves par mutations. Version 1.0.0 conservée, non publiée.
- `@astratra/conscience/governor` (phase P0) : gouverneur déterministe, sans aucun modèle de langage ni paquet d'IA (un test parcourt son graphe d'imports et un autre vérifie les modules chargés). Politique validée et gelée (`validatePolicy`) : budgets par cycle, par agent et par organisation, constitution par défaut non retirable (permissions, budgets, sécurité, confidentialité, constitution, approbations, isolation, gouverneur) et règles ajoutées, liste blanche des objets modifiables (consignes, seuils, descriptions d'outils, routage), mode « aucune modification automatique », isolation par organisation, approbateurs. `createGovernor(policy)` : `evaluatePolicy` (rejet codé de toute proposition touchant une portée protégée par sa cible, ses portées déclarées ou les clés du changement ; hors liste blanche ; inter-organisations ; mal formée ; pendant l'arrêt d'urgence ; sinon en attente d'approbation humaine ; idempotente), `approveProposal` / `declineProposal` (identité humaine fournie par l'application, jamais un modèle ; liste d'approbateurs ; pas d'auto-approbation ; comparer-puis-écrire), `authorizeSpend` (réservation atomique et idempotente), arrêt d'urgence global ou par organisation (reprise par un humain seulement), journal d'audit de toutes les décisions. `assertGovernorReady` : refus clair si le gouverneur manque, est contrefait, injoignable ou arrêté. Magasins mémoire et PostgreSQL (`postgresGovernorSchema`, verrou consultatif en transaction pour les dépenses).
- `@astratra/conscience` (phase P1) : `createConscience` (gouverneur et masqueur obligatoires) ; `recordDecision`, `recordPrediction`, `attachOutcome` (réussi, échoué, inconnu ; un résultat tardif crée une révision, l'historique reste), `recordCorrection` (seul l'écart masqué et sa classe sont gardés), `recordLesson` (registre des preuves : sans preuve, toujours une hypothèse ; preuves vérifiées dans la même organisation ; révisions), `updateSelfModel` (capacités seulement avec preuves de test), lectures `recallDecisions`, `getOutcomes`, `getLesson`, `listLessons`, `getSelfModel`, `getMemoryTimeline` (temps de l'événement, de l'enregistrement, validité, « à la date de »), `getLineage` (objectif → action → outils → résultats → corrections → leçons). Identifiants stables (double enregistrement = une ligne), isolation par organisation et par personne sur toutes les lectures et écritures, `eraseSubject` avec rapport et effaceurs injectés (vecteurs, index, calibrations), `applyRetention` explicite (aucune suppression par minuterie), garde mémoire (`frameStoredText`, `frameRecordsForModel`, encadrement de `@astratra/ai/guards`). Magasins mémoire et PostgreSQL (`postgresConscienceSchema`) ; interface documentée pour écrire son propre magasin.
- `@astratra/conscience/governor` (phase P5, gouvernance avancée) : approbations (matrice rôle par type de changement, risque = plancher du type relevé par la déclaration de la proposition, double approbation à partir d'un risque, personnes distinctes et rôles distincts en option, expiration, `expireApprovals`), registre des raisons de refus (`DECLINE_REASONS`, codes ajoutables par la politique ; `declineProposal` exige un code) et signaux de refus consultables (`listRejectionSignals`). Changements réversibles : objets versionnés (`registerObject`, historique, une candidate par objet), `stageChange` (seulement une proposition approuvée par des humains, tout revérifié : empreinte, portées protégées, approbations, expiration, version de base), `deployChange` par pourcentage et cohortes (hachage identique à `@astratra/flags`, interface `flags` injectable sans l'importer, `exportFlagRules`), `promoteChange`, `rollbackChange` (retour exact à la version précédente, à tout moment, journalisé), `resolveVersion`, arrêt d'urgence qui ramène toutes les candidates à la version stable (`halt`). Bilan du matin déterministe (`recordFinding`, `morningReport` : données, pas de texte généré, isolé par organisation). Audit complet (qui, quoi, quand, version avant et après ; `getChangeHistory`) et invariant « aucune proposition n'est appliquée parce qu'un modèle l'a approuvée » (`verifyApprovalInvariant`). Magasins mémoire et PostgreSQL étendus (`_objects`, `_versions`, `_findings`, statut `expired`). Le test de graphe d'imports reste vert : toujours aucun modèle de langage ni paquet.
- `@astratra/conscience/autoconscience` (phase P2) : `evaluateOutcomes`, `runReflection`, `createEvaluator` ; calculs déterministes sans modèle de langage. Calibration par agent/domaine (tranches, Brier, sur/sous-confiance), statistiques honnêtes (inconnus exclus, seuil configurable 30, Wilson bilatéral), coûts asymétriques, contradictions structurées et arbitrage explicite avec historique, causalité jamais établie automatiquement, calendriers métier, fidélité des justifications aux traces réelles, fiabilité des outils/fournisseurs, contre-mesures anti-Goodhart, classement des corrections et utilité/fréquence des cycles. Constats avec preuves, confiance, effectif, intervalle et statut ; calcul sans cache persistant. Vérification des leçons soumise aux preuves, aux décisions distinctes connues et à l'absence de conflit ; réévaluation en lecture après résultat tardif et effacement. Types et documentation bilingue, contrats mémoire/PostgreSQL, tests de valeurs connues et de régressions. Paquet non publié, version conservée à 1.0.0.
- `@astratra/conscience/autoconscience` (phase P3, vigilance, seconde moitié) : six modules déterministes, sans modèle de langage ni paquet, tous soumis à `assertGovernorReady` et n'appliquant jamais rien. `detectDrift` (17) : dérive des entrées (domaines, langues, longueurs), des résultats (réussi, échoué, inconnu) et des performances (calibration de P2, fiabilité des outils) par indice de stabilité de population et différence de proportions avec intervalle de Newcombe sur les intervalles de Wilson ; refus de conclure sous l'effectif minimal ; un calendrier métier de P2 explique l'écart avant qu'on l'impute à l'agent ; recommandation codée (surveiller, geler, enquêter, proposer un retour arrière), le retour arrière n'étant qu'une proposition en attente chez le gouverneur. `createFollowUps` (18) : `scheduleFollowUp` idempotent, `dueFollowUps`, isolé par organisation, question masquée, effacé avec le sujet (`followUpEraser`). `abstentionPolicy` et `shouldAbstain` (26) : seuil tiré de la calibration et des coûts d'erreur, seuil prudent sans données suffisantes, tout changement de seuil est une proposition. `generateAdversarialCases` (27) : injection, ambiguïté, cas limite, accès à une autre organisation, au format `evaluateAgent` ; générateur injecté (validé, masqué, repli sur gabarits) ou gabarits déterministes ; masqueur obligatoire. `reviewByRoles` (14) : vérificateur (preuve indépendante), contradicteur (aucune explication concurrente aussi forte), contrôleur des risques (portée) ; sinon le constat reste hypothèse. `lessonToScenario` (03) : seule une leçon vérifiée devient un scénario anti-régression. `createScenarioLibrary` : tout candidat naît « à relire » et n'entre dans les tests (`approved()`) qu'après approbation humaine du contenu exact au gouverneur. Magasins mémoire et PostgreSQL (`postgresVigilanceSchema`). Types, documentation bilingue, tests exhaustifs sur les deux magasins. Paquet non publié, version conservée à 1.0.0.
- `@astratra/conscience/autoconscience` (phase P4, mode ombre : 21, 32) : `createShadowRunner` fait traiter en silence une partie des vraies demandes par une stratégie candidate approuvée par des humains (version candidate d'un objet du gouverneur, ou proposition `approved` à approbations humaines ; en attente, déclinée, rejetée, expirée, stable ou d'une autre organisation : refusée, revérifié avant chaque exécution), parallèlement à la stable. Ses réponses ne sont jamais renvoyées : `observe` est synchrone, ne lève jamais d'erreur, n'attend jamais et ne rend qu'un accusé sans sortie ; erreurs, lenteur, masqueur ou magasin en panne et métrique fautive sont isolés, délai maximal et rafales écartées. Tous les outils passent par le bac à sable de P3 (lecture simulée ou enregistrée, écriture jamais exécutée et seulement journalisée, aucun réseau, aucun objet de l'hôte ; un appel de modèle n'est qu'un outil simulé du bac à sable). Échantillonnage déterministe par hachage, budget obligatoire et plafonné (exécutions, coût, temps, dépense du gouverneur), arrêt immédiat et définitif à l'arrêt d'urgence, au budget épuisé ou quand la candidate n'en est plus une. `ShadowRun` masqué (masqueur obligatoire) avec scores par métrique, intentions d'écriture, durée, coût et incidents ; `report` : statistiques honnêtes de P2 (Wilson, effectif minimal, différence de Newcombe), contre-mesures anti-Goodhart de P2 (au moins une exigée), régressions critiques listées, conclusion codée `insufficient_data` / `regression` / `no_difference` / `promising`, jamais « prouvé » (`provesImprovement: false`, `applied: false`) ; un résultat prometteur ne devient qu'une proposition en attente chez le gouverneur, jamais un déploiement ni une promotion. Isolation par organisation, effacement d'un sujet (`shadowEraser`, `eraseSubject`), magasins mémoire et PostgreSQL (`postgresShadowSchema`), types, documentation bilingue, tests exhaustifs sur les deux magasins. Paquet non publié, version conservée à 1.0.0. Seule la P6 (intégration et transfert encadré) reste hors du paquet.
- Ajouté à `ORDER` de `scripts/publish-all.sh` après `@astratra/memory` (dépend de `@astratra/ai` ^1.8.0).

## 2026-10-09 — `@astratra/centrale` 1.0.3 (sécurité)

### Corrigé
- Masquage : les règles des jetons (JWT, `Bearer`/`Basic`, clés à préfixe) avaient des répétitions sans borne ; une suite piégée comme « eyJ-eyJ-… » restait quadratique (environ 28 ms par texte de 10 000 caractères). Chaque segment est maintenant borné. Le test de non-régression couvre ces nouveaux cas.

## 2026-10-09 — `@astratra/centrale` 1.0.2 (sécurité)

### Corrigé
- Masquage : la règle des adresses e-mail était quadratique sur une longue chaîne sans « @ » (environ 30 ms par texte de 10 000 caractères, de quoi bloquer un serveur avec quelques envois). Elle est maintenant bornée (64 caractères avant l'arobase, 255 après) et sautée quand le texte ne contient aucun « @ ». Test de non-régression : 100 textes piégés masqués en moins d'une seconde.

## 2026-10-09 — retours 👍/👎 : `@astratra/native-ui` 1.1.0, `@astratra/saas-kit-ui` 1.1.0 (et `@astratra/agent` 1.0.0)

### Added
- `@astratra/agent` (not yet published, stays 1.0.0), subpath `@astratra/agent/feedback` and main entry: user feedback on runs. Model with one feedback per person and run (give, modify, withdraw), fixed extensible reasons, bounded comment; memory and PostgreSQL stores with an exported schema; optional Express router (`createFeedbackRouter`) where the application supplies identity and run ownership (404 otherwise); `feedbackDigest` (bounded, masked summary of recent dislikes); `exportScenarioCandidates` (anonymous candidates for `evaluateAgent`, mandatory masker) and `toAgentScenarios`; statistics by agent, mode, reason and period.
- `@astratra/agent`: option `feedback` of `createAgent` adds the person's digest to the system prompt at the start of a task (`userId` / `tenantId` in the task input, kept in `task.feedbackDigest`); events `run` and `final` expose `runId`. Backward compatible. Optional peer `express`.
- `@astratra/native-ui` 1.1.0: `FeedbackBar` (React Native / Expo), glass thumbs, reason sheet with optional comment, accessibility, optional haptics (`expo-haptics`, optional peer), English and French default labels overridable by the app, pure rules exported from `@astratra/native-ui/logic`.
- `@astratra/saas-kit-ui` 1.1.0: the same `FeedbackBar` for React on the web, with its pure rules.
- `create-astratra-app` 1.9.0: generated dashboards ask for `@astratra/saas-kit-ui` ^1.1.0.

## 2026-10-09 — `@astratra/agent` 1.0.0, `@astratra/testkit` 1.1.0

### Added
- `@astratra/agent`: long task execution built on the existing native tool loop, time/turn/token/cost budgets, cancellation, plans, completion verification and context compaction.
- `@astratra/agent`: guards by default. `createAgent({ guards })` takes the guards of `@astratra/ai/guards` (`createGuards` / `recommendedGuards`) and calls them at the right moments: `newRun` at the start of a task (mode `action` when a tool writes or confirms, else `read`), `input` on the question and earlier messages before any model, `toolResult` on every tool result (tools marked `external: true` are scanned for injection and framed as untrusted data), `beforeAction` before any tool that writes or needs confirmation (a refusal after a suspected injection puts the task in `waiting_confirmation` until the application confirms that very call, and the tool does not run; a refusal for another reason is read by the model), `output` on the final reply (unmasking, grounding, leaks, moderation; a blocked reply is never delivered: task `failed`, `stopReason: 'guard'`). Guard events are relayed by `onEvent` as `type: 'guard'`. The run state (masking table, confirmation flag, hashes, masked sources) is kept in `task.guards` so a resumed task behaves identically; tools receive `context.unmask`. Without `guards`, production (`NODE_ENV=production`) refuses with `guards required in production: pass guards or guards:false`; elsewhere one `warning` event (`guards_missing`) is sent and nothing is guarded; `guards: false` is the explicit opt-out. The package is not yet published, so this stays 1.0.0 and is not a breaking change. `@astratra/ai` floor raised to ^1.8.0.
- Durable task checkpoints, per-turn consumption events, confirmation suspension, memory and injected PostgreSQL task stores with renewable fenced leases and an exported schema.
- `@astratra/testkit`: injected agent scenario evaluation, simulated tool traces, assertions, custom scoring and aggregate reports compatible with `node --test`.
- Root validation: declare ESM fixtures and Node fetch in ESLint; align a mobile refresh regression with the existing refusal-versus-network contract. No published mobile source changes.
- `create-astratra-app` 1.8.1: generated projects now ask for the current floors of `@astratra/ai` (^1.7.0), `@astratra/credentials` and `@astratra/client` (^1.1.0).
- Public declarations, installation examples, module tests and conditional real PostgreSQL coverage. No change to `@astratra/ai` or existing database migrations.

## 2026-10-09 — gardes d'agents : `@astratra/models` 1.1.0, `@astratra/ai` 1.8.0 et `create-astratra-app` 1.9.0

Des protections d'agents IA complètes, fondées sur des modèles ouverts existants (rien n'est entraîné),
téléchargés depuis Hugging Face à des versions figées. Aucun poids dans les paquets npm, aucun
téléchargement à l'installation. Tout est rétrocompatible.

### `@astratra/models` 1.1.0

#### Ajoute
- **Deux modèles locaux** dans le service Python, chargés comme les autres (paresseux, facultatifs, ONNX sur
  processeur) : `POST /injection` (détection d'injection de consignes et de jailbreak, français et anglais
  vérifiés, texte long lu par fenêtres qui se recouvrent, jamais coupé) et `POST /moderation` (score global et
  par catégorie : haine, harcèlement, violence, sexuel, sexuel impliquant un mineur, automutilation ; jamais
  d'extrait du texte). Client : `models.injection(text|texts)` et `models.moderation(text|texts)`, avec délais,
  relances, disjoncteurs et dégradation par point d'entrée. Réglages `MODELS_INJECTION_*` et
  `MODELS_MODERATION_*`. Modèles retenus : `Horizon-Labs/prompt-injection-guard-small` et
  `Horizon-Labs/content-safety-guard-small` (Apache-2.0) ; candidats comparés et écartés dans
  `docs/guard-models.md` (et `.fr.md`), limites comprises (`sexual_minors` est faible).
- **Manifeste figé** `data/models-manifest.json` des sept modèles : dépôt Hugging Face, hash de commit, fichiers
  avec taille et SHA-256, licence. Mentions dans `data/MODELS-NOTICE`. `scripts/build-manifest.js` le régénère.
- **Commande `astratra-models`** (bin) : `fetch [--models a,b] [--dir DIR] [--check] [--json]` télécharge exactement
  les fichiers figés, vérifie chaque SHA-256 (un écart supprime le fichier et fait échouer), reprend un
  téléchargement interrompu, refuse de tourner tant qu'un SHA-256 est à compléter ; `--check` vérifie sans
  réseau ; `list`.
- **`assertModelsReady({ required })`** : au démarrage, lève `ModelsNotReadyError` en production si un modèle requis
  manque ou diffère du manifeste. Aussi exportés : `loadManifest`, `checkModels`, `fetchModels`.
- Le service passe en version `1.1.0` ; `injection` et `moderation` rejoignent `MODELS_ENABLED` par défaut (un
  modèle absent répond `503 model_unavailable`, les autres continuent).

### `@astratra/ai` 1.8.0

#### Ajoute
- **`@astratra/ai/guards`** (champ `exports`, avec `.` et `./package.json` inchangés pour les usages existants) :
  `createGuards({ models, policy, ... })` et le préréglage `recommendedGuards(...)`. Gardes `input` (masquage
  réversible des noms et données personnelles), `toolResult` (injection dans les résultats d'outils externes,
  contenu encadré comme donnée non fiable, interdiction de toute action sans confirmation humaine ensuite),
  `output` (ancrage dans les sources lues par NLI, fuite de données personnelles, modération),
  `beforeAction`. Politique de panne `failClosed` par défaut, `failOpen` possible pour la lecture. Chaque décision
  produit un événement sans texte brut. Le client de `@astratra/models` est injecté (aucune dépendance) ;
  `@astratra/rag` est une dépendance de pair facultative.
- **Run kept across a restart**: `guards.exportRun(run)` / `guards.restoreRun(snapshot)` (plain JSON: masking table, confirmation flag, hashes of the personal data given, external sources masked), `guards.subscribe(listener)` for every event, and `snapshot()` / `restore()` on `createReversibleMasker`. Used by `@astratra/agent`.
- **`@astratra/ai/guards/testing`** : `createFakeModels`, `createMockGuards`, `createEventRecorder`, sans modèle.

### `create-astratra-app` 1.9.0

- Le plancher de `@astratra/ai` des projets générés passe à `^1.8.0` et celui de `@astratra/credentials` à `^1.1.0` (ses tests comparent chaque plancher à la version du dépôt).

## 2026-10-09 — documentation neutre : `@astratra/centrale`, `@astratra/centrale-cli`, `@astratra/loyalty`, `@astratra/testkit` 1.0.1

### Documentation et commentaires neutres
- Commentaires, descriptions et données de test des paquets retirent les noms de projets d'origine ; aucun comportement ne change.
- `@astratra/centrale` et `@astratra/centrale-cli` gardent leur nom ; leur description est générique.
- `@astratra/testkit` : une région de la liste de test de `@astratra/testkit` est remplacée par une autre (donnée de test).
- Licence : titulaire du copyright « Astratra contributors ».

## 2026-10-08 — `@astratra/memory` 2.0.0 et `@astratra/voice` 1.1.0 : ce que les apps écrivaient autour

Deux applications existantes ont basculé sur ces paquets mais ont dû écrire du code autour. Ces
manques sont comblés dans les paquets. Tout est rétrocompatible, sauf un défaut relevé (voir « Rupture »).

### `@astratra/memory` 2.0.0

#### Rupture
- Comportement par défaut modifié (règle de PUBLISHING.md : version majeure) : le plafond passe de 300 à 1000
  souvenirs actifs par personne. Aucune signature ni export n'a changé ; pour retrouver l'ancien plafond,
  `maxActive: 300`.

#### Modifié
- **Plafond de souvenirs : 1000 par personne au lieu de 300** (décision de conception). Une personne qui avait
  entre 301 et 1000 souvenirs actifs en garde désormais tous. Pour l'ancien comportement :
  `maxActive: 300`.

#### Ajoute
- `maxActive` reste réglable (`0` ou `null` : pas de plafond) ; nouvelle option `trimAbove` : le ménage ne
  démarre qu'au-dessus de ce nombre et ramène la personne à `maxActive` (par défaut `maxActive` : comme
  avant). Sous le seuil, le plafond ne coûte plus aucune lecture supplémentaire. `DEFAULT_MAX_ACTIVE`
  exporté.
- **Renforcer un doublon** : option `onDuplicate: 'replace' | 'reinforce'` (défaut `'replace'`, comportement
  inchangé), surchargeable par appel (`remember(where, { onDuplicate })`). En `'reinforce'`, le souvenir
  redit garde **le même identifiant**, son texte, son genre et sa date de création, prend l'importance
  maximale et rafraîchit `updatedAt` ; un vecteur qui lui manquait est complété. Résultat :
  `{ ok: true, memory, supersededId: null, reinforced: true }`. L'outil `remember` répond alors
  `reinforced: true` et `undo: null`. La consolidation suit la même option. `DUPLICATE_MODES` exporté.
- `memory.markUsed(where, ids)` : marque des souvenirs comme utilisés sans passer par la recherche
  (renvoie le nombre marqué ; identifiants inconnus, remplacés ou d'une autre personne ignorés).
- Pause : `memory.pause(where)` / `memory.resume(where)` (à côté de `isPaused` / `setPaused`), et
  `handlers.pause(where)` / `handlers.resume(where)`, ajoutés aux `PRIVACY_OPERATIONS` (ils marchent IA
  coupée).
- **Magasin PostgreSQL de référence** : `createPostgresMemoryStore(db, options)` et
  `postgresMemorySchema(options)` (SQL des trois tables, idempotent). Requêtes paramétrées, lieu
  `{ ownerId, scope }` dans chaque requête, recherche plein texte (`tsvector` généré + GIN, configuration
  réglable), pgvector en option (`vectors: 'pgvector'`, colonne `vector(N)`, index HNSW cosinus) ou vecteurs
  jsonb comparés dans le processus. Identifiant, personne et lieu en `text` ou `uuid` ; `scopeReferences`
  fait du lieu une clé étrangère (`ON DELETE CASCADE`). Un lieu ou un identifiant d'une mauvaise forme ne
  trouve rien, il ne lève jamais. Sans dépendance à `pg`.
- `runStoreContract` : `makeScope(name, store)` et `makeOwner(name, store)` pour les magasins dont le lieu est
  une clé étrangère ou a une forme, et `vectorDimensions` pour les colonnes de taille fixe. Un `newId`
  donné à une suite n'affecte plus les suivantes.
- Tests : le contrat et des scénarios de bout en bout contre un vrai PostgreSQL quand
  `MEMORY_TEST_DATABASE_URL` (base finissant par `_test`) est donné, pgvector avec `MEMORY_TEST_PGVECTOR=1` ;
  sans base, requêtes, schéma et refus sont testés quand même.

### `@astratra/voice` 1.1.0

#### Ajoute
- **Piper par HTTP** : `createPiperHttpProvider({ url, token | tokenFile, ... })`, un fournisseur pour la
  chaîne `createProviderVoiceService` (`POST {url}/tts` avec `{ text, lang }`, jeton lu à chaque requête
  dans un fichier ou donné en option, format selon le `Content-Type`, délai en panne transitoire, erreurs
  HTTP classées par `classifyProviderError`). À côté du Piper en ligne de commande, qui reste inchangé.
- **Annulation par `AbortSignal`** : `synthesize({ ..., signal })` sur `createVoiceService`,
  `createProviderVoiceService` et `createPieceVoiceService`, transmis jusqu'au travail (processus `piper` et
  `ffmpeg` tués, `runProcess` accepte `signal`, requêtes de `createGeminiTtsAdapter`,
  `createPiperHttpProvider`, `createWhisperHttpEngine` et `asVoiceProvider` annulées, fichiers temporaires
  retirés). L'erreur est toujours `AbortError` / `code: 'ABORTED'` ; une annulation n'est pas une panne du
  fournisseur : aucun autre fournisseur essayé, aucune clé mise au repos, rien en cache.
  `classifyProviderError` reconnaît `ABORTED`. Sans signal, rien ne change.
- **Cache à taille bornée** : `createBoundedVoiceCache({ maxEntries, maxBytes, now })`, même interface que
  `createMemoryVoiceCache`, le moins récemment utilisé part d'abord, durée de vie du service respectée,
  `size` et `bytes`. Sans limite, 256 lectures.
- Tests et déclarations de types pour tout cela.

## 2026-10-08 — `@astratra/credentials` 1.1.0 : coffre strict et isolé

### Ajoute
- Lecture stricte optionnelle et repli désactivable, erreurs et événements sans valeurs.
- Espaces par locataire/environnement ; chiffreur AES-256-GCM à contexte AAD
  (locataire, environnement, nom, version), rotation classique avec contexte.
- Historique optionnel : écritures atomiques versionnées, lecture courante ou historique,
  métadonnées, conservation depuis le retrait et purge des anciens chiffrés.
  Stores mémoire et Mongo dédiés ; contrat injectable pour les autres bases.
- Crochet `onWrite` après écriture et invalidation locale, erreur déclarant l'écriture
  validée si le crochet échoue ; documentation du rechargement entre processus.
- Défi court à consommation atomique pour une lecture, vérificateur injectable,
  stores mémoire/Mongo ; sondes génériques avec transport injecté et statuts sûrs.
- Types, exemples et tests de régression ; comportement historique conservé par défaut.

### Corrige
- Les journaux du coffre et de sa rotation ne reprennent plus les messages bruts
  du store ou du chiffreur, susceptibles de contenir une valeur.
- Une lecture en cours ne remet plus une ancienne image en cache après une écriture.

## 2026-10-08 — `@astratra/ai`: configured routing, local models and voice 1.7.0

### Added
- `createConfiguredRouter` above the existing provider router: per-usage and
  complexity/intent selection, OpenAI/Gemini provider configuration, rotating
  keys, vision/context filtering, model extras, quotas with safety margins,
  cooldowns/degradation, 12s/45s deadlines, and fallback without tools.
- Atomic injectable routing state: memory, Redis CAS and PostgreSQL transaction
  adapters; `readAiConfigFromEnv` with configurable variable prefix.
- `createLocalModelsClient`: rerank/NLI/entities/vectors/Whisper HTTP
  contracts, Bearer file cache, validated results and independent route circuits.
- Local-first transcription (Whisper → Groq → Cloudflare), speech (Gemini TTS
  en ligne d'abord, Piper local en repli ; `order` pour inverser), WAV helpers and fastText service language detection with heuristic fallback.
- Opt-in native tool risk validation and threshold confirmation, undo-aware
  low-risk execution and injected untrusted-source exposure policy.
- Public TypeScript declarations, usage examples, contract tests and three
  mutation checks. Existing APIs/defaults retained; package version unchanged.

## 2026-10-07 — `@astratra/centrale` 1.0.0 et `@astratra/centrale-cli` 1.0.0 : nouveaux paquets

Venus du dépôt d'un hub de surveillance auto-hébergé (`paquets/`), où ils sont nés.

### Ajoute
- `@astratra/centrale` : le paquet de collecte d'un hub de surveillance auto-hébergé (erreurs, plantages, vues, usages,
  sessions, appels d'IA), masqués à la source et envoyés par lots. Entrées `/node`, `/navigateur`,
  `/expo`, `/ia`, plus `/envoi` (le contrat d'envoi) et `/masquage`, repris par le backend.
  Aucune dépendance.
- `@astratra/centrale-cli` : la commande `centrale` (identifiants de débogage dans les builds,
  envoi des cartes de code, déclaration des déploiements).
- Premiers paquets Astratra écrits en TypeScript : publiés construits (`dist/`, JavaScript et types,
  par `prepack`), parce que Node n'exécute pas le TypeScript d'un paquet installé.

## 2026-10-07 — `@astratra/saas-kit` 1.6.1, `@astratra/client` 1.1.0, `create-astratra-app` 1.8.0 : sessions plus robustes

### Corrige
- `saas-kit` : le limiteur des connexions s'appliquait à tout `/auth`. Après une dizaine
  d'ouvertures d'une app (`GET /auth/me`, renouvellements), la connexion était bloquée 15 minutes.
  Il ne compte plus que `POST /auth/login`, `/auth/forgot-password` et `/auth/reset-password` ;
  l'option `loginRateLimit.skip` de l'application reste respectée.
- `client` : `createSessionClient` mettait fin à la session au moindre échec du renouvellement.
  Une coupure réseau, un 5xx ou un 429 renvoient désormais l'erreur telle quelle et gardent la
  session ; l'appel suivant réessaie. Seul un refus du serveur (400, 401, 403) appelle
  `onSessionExpired` et lève `SessionExpiredError`.

### Ajoute
- `client` : option `isRefusal(refreshError)` pour redéfinir ce qui met fin à la session.

### Change
- `create-astratra-app` : les nouveaux projets demandent `@astratra/saas-kit` ^1.6.1 et,
  dans le gabarit mobile, `@astratra/client` ^1.1.0.

## 2026-10-02 — `@astratra/tooling` 1.5.0 : mise à jour à distance sûre

### Corrige
- `publish update` échouait (eas-cli exige `--environment` depuis 2026, et préparait aussi la version web)
  et, sans cela, aurait envoyé le `.env` local : une application dont l'adresse du serveur est
  `http://127.0.0.1:3000`, coupée de son serveur. Le paquet est désormais préparé sur la machine avec
  les variables du profil de `eas.json` (`extends` compris), iPhone et Android seulement, puis envoyé
  par `eas update --environment … --skip-bundler --input-dir …`.
- Deux garde-fous : une variable `EXPO_PUBLIC_*` qui pointe vers la machine arrête tout avant la
  préparation ; une adresse locale du `.env` retrouvée dans le paquet (JavaScript ou bytecode Hermes)
  arrête tout avant l'envoi. Le dossier préparé est toujours supprimé.

### Ajoute
- `publish.eas.environment` (défaut `production`) et `publish.expoCommand` (défaut `npx expo`).
- `buildEasUpdateArgs` prend `environment` et `inputDir` (obligatoire, absolu).

## 2026-10-01 (35) — tous les paquets en 1.x, huit nouveaux paquets, trois fusions

Décision : plus aucun paquet Astratra en 0.x. Les 27 paquets encore en 0.x (publiés ou nouveaux)
passent en **1.0.0** ; un nouveau paquet naît désormais en 1.0.0. Le simple passage en 1.0.0
n'ajoute **aucune rupture d'API** : un projet sur `^0.y.z` doit seulement relever son plancher à
`^1.0.0` (un caret sur une 0.x ne franchit pas la mineure, il ne prendrait jamais la 1.0.0 seul).

| Paquet | Avant | Après |
|---|---|---|
| `@astratra/ai` | 1.5.0 | 1.6.0 |
| `@astratra/tooling` | 1.3.1 | 1.4.0 |
| `create-astratra-app` | 1.6.1 | 1.7.0 |
| `@astratra/app-guide`, `app-version`, `closure`, `models` | 0.1.0 | 1.0.0 |
| `@astratra/i18n-server`, `live`, `loyalty`, `memory`, `native-ui`, `payments`, `pdf`, `prerender`, `rag`, `react`, `resilience`, `wallet` | 0.2.0 | 1.0.0 |
| `@astratra/client`, `native`, `notify`, `privacy`, `voice` | 0.3.0 | 1.0.0 |
| `@astratra/credentials` | 0.4.0 | 1.0.0 |
| `@astratra/entitlements` | 0.5.0 | 1.0.0 |
| `@astratra/booking`, `collab`, `fhir`, `ledger`, `srs`, `testkit` (nouveaux) | — | 1.0.0 |
| `@astratra/flags`, `repomap` (nouveaux) | — | 1.0.0 |

Inchangés (contenu identique à la version en ligne) : `core` 1.1.0, `security` 1.11.0,
`saas-kit` 1.6.0, `saas-kit-ui` 1.0.1, `store-mongo` 1.1.0, `store-postgres` 1.1.0.

### Ajoute

- `@astratra/booking` 1.0.0 (nouveau) — moteur de créneaux de rendez-vous sans base imposée :
  disponibilités hebdomadaires par ressource, exceptions et jours fériés, fuseaux et heure d'été,
  durée de prestation, battements, préavis minimal, horizon, capacité, réservation atomique par
  magasin injecté (échec en cas de conflit), annulation et report.
- `@astratra/collab` 1.0.0 (nouveau) — édition collaborative en temps réel : serveur Hocuspocus
  branché sur l'authentification de l'application (lecture/écriture par document), persistance
  injectée en instantanés Yjs, versions nommées et restauration, limites de taille, éditeur
  Tiptap sans interface, conversion Yjs vers JSON, Markdown et HTML pour la recherche et l'export.
- `@astratra/fhir` 1.0.0 (nouveau) — aides FHIR R4 sur les types officiels Medplum : validation
  minimale de Patient, Encounter et Observation, références et constructeurs.
- `@astratra/flags` 1.0.0 (nouveau) — évaluation déterministe de fonctionnalités et
  d'expériences : ciblage, déploiement progressif, fournisseur compatible OpenFeature.
- `@astratra/ledger` 1.0.0 (nouveau) — comptabilité en partie double : écritures équilibrées et
  immuables, numérotation sans trou, clôture, lettrage, rapprochement bancaire, états SYSCOHADA,
  plans OHADA (SYSCOHADA, SYSCEBNL) et TVA de la RDC ; données livrées avec leur `NOTICE`.
- `@astratra/repomap` 1.0.0 (nouveau) — carte pondérée des symboles d'un dépôt (tree-sitter) pour
  explorer du code dans un budget de jetons.
- `@astratra/srs` 1.0.0 (nouveau) — répétition espacée sur FSRS : cartes, notation
  Again/Hard/Good/Easy, prochaine échéance, paramètres FSRS, file du jour et statistiques,
  magasin injecté.
- `@astratra/testkit` 1.0.0 (nouveau) — bases de test jetables (MongoDB ou PostgreSQL en
  conteneur), fausses données reproductibles par pays, garde qui refuse toute adresse de base
  ressemblant à la production.
- `@astratra/ai` 1.6.0 — boucle d'agent : garde contre les appels répétés (même outil, mêmes
  paramètres : rappels à 3 et 5, arrêt à 8, réglables par `loopGuard`, événements
  `tool_loop_warning` / `tool_loop_stopped`) ; mise de côté des gros résultats d'outil
  (`spill`, seuil 12 000 caractères, `createMemorySpillStore`, outil `read_spilled_result` pour les
  lire par tranches) ; niveaux de risque `LOW` / `MEDIUM` / `HIGH` / `UNKNOWN` (`TOOL_RISKS`),
  `confirmationPolicy` (`'always'`, `'never'`, `{ threshold }`, inactive par défaut) et
  `riskAnalyzers`. Fournisseur llama.cpp pour un modèle local sur CPU
  (`createLlamaCppProvider`, `createLlamaCppConfig`, `normalizeLlamaCppUrl`, `LocalLlmError`,
  `chatStream`, état de santé) et un `docker-compose.yml` de `llama-server` dans `deploy/`.
  API rétrocompatible ; la garde et la mise de côté sont actives par défaut (voir « Change »),
  la politique de confirmation ne l'est pas.
- `@astratra/models` 1.0.0 — catalogue des prix des modèles hébergés et coût d'un appel
  (`createPriceCatalog`, `normalizeUsage`, `diffPriceCatalogs`, `loadBundledCatalog`) : cache en
  lecture et en écriture, audio, paliers de long contexte, surcharges locales, coût figé, fenêtre
  de contexte et capacités ; catalogue LiteLLM (MIT) du 2026-10-01 livré dans `data/` avec son
  `NOTICE`, mis à jour par `npm run prices:update`.
- `@astratra/entitlements` 1.0.0 — droits IA (`createAIEntitlements`,
  `createMemoryAIEntitlementsStore`) : clés gardées par empreinte SHA-256 (secret montré une seule
  fois), modèles et groupes par plan, alias, quotas par minute et par jour, budgets jour/mois,
  `execute` qui réserve l'estimation puis règle au coût réel, repli dont chaque cible est
  revérifiée (modèle, quota, budget) avant l'appel, révocation immédiate ; les restrictions d'une
  clé ne peuvent jamais élargir les droits du compte.
- `@astratra/voice` 1.0.0 — voix et transcription locales sur CPU (`createLocalSpeech`,
  `createSherpaEngine` avec `sherpa-onnx-node` en dépendance pair optionnelle,
  `createWhisperHttpEngine` pour un service faster-whisper, `asVoiceProvider`,
  `asTranscriptionProvider`, `decodeWav`, `resample`).
- `@astratra/rag` 1.0.0 — lecture de documents par un service Docling (`createDoclingClient`,
  `ExtractionError`, `MEDIA_TYPES`) : PDF, Office et images convertis en Markdown, JSON, texte ou
  HTML, tableaux rendus en grilles et en Markdown (`extractTables`, `gridFromTable`,
  `tableToMarkdown`) ; `docker-compose.yml` de `docling-serve` dans `deploy/`.
- `@astratra/tooling` 1.4.0 — commande `astratra eval` : évalue une IA sur un fichier de cas
  (`loadCases`, `buildProvider`, `buildPromptfooConfig`, `runEval`, `summarizeEval`), seuil de
  réussite `--min-pass`, fournisseur compatible OpenAI (dont llama.cpp) ou promptfoo ;
  `promptfoo` en dépendance pair optionnelle ; exemple de cas dans `examples/`. Publication :
  `publish.eas.mode: "local"` fabrique sur la machine (`eas build --local`) puis envoie aux
  stores comme un build EAS, dossier de travail `eas.localWorkDir` vidé à chaque build.
- `create-astratra-app` 1.7.0 — planchers relevés : `@astratra/ai` ^1.6.0 ; toutes les briques
  `--with` (credentials, entitlements, notify, payments, privacy, resilience, i18n-server, pdf,
  closure, client, prerender) en ^1.0.0 ; gabarit mobile : `@astratra/client` et
  `@astratra/native` en ^1.0.0.

### Fusionne

Trois paquets jamais publiés sont fondus dans un paquet existant ; aucun nom `@astratra/…` ne
disparaît du registre :

- `speech-local` → `@astratra/voice` (`src/local`) ;
- `local-llm` → `@astratra/ai` (fournisseur llama.cpp) ;
- `extraction` → `@astratra/rag` (`src/extraction`, Docling).

### Change

- `@astratra/ai` 1.6.0 — comportement par défaut de `runAgentLoop` : un même appel d'outil répété
  reçoit un rappel à la 3e et à la 5e fois (arrêt à la 8e si `maxSteps` le permet), et un résultat
  d'outil de plus de 12 000 caractères est remplacé, pour le modèle, par un extrait et une
  référence lisible par tranches. Aucune signature ne change ; pour retrouver l'ancien
  comportement : `loopGuard: { reminder: Infinity, firmReminder: Infinity, stop: Infinity }` et
  `spill: { threshold: Number.MAX_SAFE_INTEGER }`.
- Dépendances internes relevées : `@astratra/native` → `@astratra/client` ^1.0.0,
  `@astratra/native-ui` → `@astratra/native` ^1.0.0, `@astratra/live` → `@astratra/voice` ^1.0.0,
  `@astratra/ai` (développement) → `@astratra/resilience` ^1.0.0.
- `scripts/publish-all.sh` connaît les 40 paquets et refuse de démarrer si un paquet est placé
  avant une de ses dépendances internes ; `scripts/verify-package-installation.js` lit
  `packages/` au lieu d'une liste écrite à la main.
- `package-lock.json` : quatre entrées de paquets supprimés depuis longtemps (`invitations`,
  `mailer`, `offline`, `session-client`) retirées.

### Sécurité

`npm audit --omit=dev` à la racine : 17 vulnérabilités (1 faible, 13 modérées, 3 hautes) → 0.

- `@astratra/testkit` 1.0.0 — `@faker-js/faker` passe de 9.9 à **10.6** (faille d'exécution de
  code par `helpers.fake`, corrigée seulement en 10.x). faker 10 n'existe qu'en module ES : le
  paquet fournit un préréglage Jest (`preset: '@astratra/testkit'`) qui le fait convertir par
  babel-jest ; nouvelle dépendance `@babel/plugin-transform-modules-commonjs` (MIT).
- `@astratra/wallet` 1.0.0 — `passkit-generator` 3.6.1 (dernière version) épingle `joi` 17.13.4
  (trois failles, dont une expression régulière quadratique dans `isoDate()`). La racine force
  `joi` 17.13.8 par `overrides` ; npm ne transmet pas les `overrides` d'un paquet installé, le
  README indique celui à ajouter dans l'application.
- Racine : `overrides` `xcode` → `uuid` ^11.1.1 (chaîne `expo`, installée comme pair de
  `@astratra/native-ui`) ; verrou relevé : `express` 4.22.3, `body-parser` 1.20.8, `qs` 6.16.0,
  `js-yaml` 4.3.2. Aucun `package.json` de paquet déjà publié ne change.

### Ordre de publication

Calculé par tri topologique des dépendances internes réelles (voir `docs/PUBLISHING.md`) :
`core`, `security`, `rag`, `credentials`, `entitlements`, `notify`, `client`, `native`,
`native-ui`, `payments`, `privacy`, `resilience`, `ai`, `memory`, `models`, `i18n-server`,
`pdf`, `loyalty`, `wallet`, `closure`, `app-version`, `app-guide`, `voice`, `live`,
`prerender`, `react`, `tooling`, `saas-kit`, `saas-kit-ui`, `store-mongo`, `store-postgres`,
`booking`, `collab`, `fhir`, `flags`, `ledger`, `repomap`, `srs`, `testkit`, puis
`create-astratra-app` en dernier. `bash scripts/publish-all.sh` suit cet ordre et saute les
six paquets inchangés.

## 2026-09-29 (34) — une application reprend ses briques depuis les paquets : ce que la production demandait

`@astratra/memory` 0.2.0, `@astratra/rag` 0.2.0, `@astratra/ai` 1.5.0, `@astratra/voice` 0.3.0,
`@astratra/live` 0.2.0 (dépend de `@astratra/voice` ^0.3.0 : publier `voice` d'abord) et
`@astratra/tooling` 1.3.1, puis `create-astratra-app` 1.6.1. L'application remplace sa mémoire, sa recherche, sa couche d'IA, sa voix,
son direct et ses scripts de déploiement par ces paquets ; ce qui leur manquait y est ajouté.

### Ajoute

- `@astratra/memory` 0.2.0 — `readExtraction()` lit les réponses de modèles telles qu'ils les
  écrivent (bloc de code, phrase autour, retours à la ligne bruts, virgule finale, liste de faits
  seule, faits en texte, `memories`/`updates`/`fact`/`type`/`priority`, réponse coupée : chaque
  fait entier avant la coupure est gardé). `consolidate()` dit pourquoi elle échoue (`reason` :
  `model`, `unreadable`, `store`, `invalid_where`, `error`), compte `failed` et `proposed`, et
  chaque écriture vit seule. `update(..., { inPlace: true })`, `transcriptKeep: 'end'`, option
  `fill` du portrait, `list(..., { withVector: false })`, `createLocalLock` exporté ; le contrat
  de magasin accepte `newId` et tourne sous `node:test`.
- `@astratra/rag` 0.2.0 — indexation incrémentale par tranches (`listSourceChunkIds`,
  `putDocuments`, `commitSource`), passages déjà découpés par l'application (`chunks`),
  empreinte connue avant lecture (`fingerprint`), source illisible « garée »
  (`noteSourceFailure`), borne de passe (`maxPassages`, `remaining`), erreurs `fatal`, magasin et
  vectoriseur donnés par fonction, `watch` avec `onRun` / `onError`. Recherche : `alsoIn`,
  `rerankMode: 'fuse'`, `perDocumentReranked`, `ties`, filtre transmis au magasin. Vectoriseur
  distant : `external: false`, réponse `model` ou `modelId`, `maxRetryDelayMs`, erreurs `fatal`
  avec `status` et `code` ; `limits` sur le vectoriseur.
- `@astratra/ai` 1.5.0 — routage d'une demande : `candidates`, `select`, `accepts`, `partial`
  et `wholeSentences`, `available`, voies à clé propre (`lane`), `cooldownOn`,
  `whenAllCooling: 'try'`, horloge injectée, `route()` qui dit qui a répondu, `reset()`, arrêt net
  quand l'appelant part ; adaptateur Gemini ; format OpenAI : adresse et clé relues par appel,
  `extra` par modèle, `</think>` sans ouverture, appels d'outil écrits dans le texte relus et
  jamais montrés, arguments illisibles expliqués (`invalidReason`) et renvoyés en `{}` ; outils
  natifs et leur boucle (`validateNativeTools`, `createToolCaller`, `runToolLoop`) ; flux SSE
  (`openEventStream`) ; recherche Serper (`searchSerper`) ; `tidyMarkdown({ remove })`.
- `@astratra/voice` 0.3.0 — `createMicrophoneGate`, `createUtteranceSegmenter`,
  `createReadingAssembler` et `buildReadingGraph`, `createResidentPiperPool`,
  `createFileVoiceCache`, `restingLast`, `VOICE_FINISH`, `VOICE_LOUDNESS`, `pcm16ToWav`,
  `runProcess`.
- `@astratra/live` 0.2.0 — `createTranscribedRelay` (confidentiel : le son reste sur le serveur,
  le fournisseur reçoit du texte et garde sa voix), options de session `instructions`, `tools`,
  `wire`, `microphone`, `observe`, `onEnd`, `directInterrupt` ; adaptateur Gemini : `candidates`
  en fonction, `gaveOut`, `handover`, `toolError`, `maxImageChars`.
- `create-astratra-app` 1.6.1 — plancher relevé à `@astratra/ai` ^1.5.0. À publier en dernier.
- `@astratra/tooling` 1.3.1 — essais à blanc du déploiement et de la publication (`--dry-run`),
  marqueurs distants configurables, vérification de la branche distante réelle et du statut SSH.

### Change

- `@astratra/memory` — deux vecteurs de longueurs différentes ne sont plus jamais comparés ;
  `forget` d'une ancienne version renvoie `false` ; une importance faite d'espaces retombe sur la
  valeur par défaut.
- `@astratra/voice` — garde d'écho : la fenêtre ne compte que le son, une voix reconnue passe
  tant que son flux continue, un échec du comparateur l'arrête pour le reste de l'appel ;
  `splitSpeechPieces` garde le guillemet fermant avec sa phrase ; la chaîne de transcription donne
  `requestedLanguage` aux fournisseurs.
- `@astratra/live` — le micro seul ne tient plus un appel ouvert ; la conversation reprise est
  racontée dès la première ligne ; une clé ne se repose que sur un refus de clé ou de quota ; les
  outils demandés ensemble s'exécutent ensemble ; `saved` arrive même pendant la fermeture ;
  `attachLive` répond `BUSY` et s'arrête avec 1001.
- `@astratra/tooling` — une configuration Apple invalide échoue explicitement ; une remise
  manuelle ne marque plus l'empreinte native comme publiée ; un succès suivi d'une coupure SSH est
  signalé comme état inconnu.

## 2026-09-28 (33) — extraction de deux assistants d'IA : voix, direct, recherche, modèles, publication

Nouveaux paquets `@astratra/rag` 0.1.0, `@astratra/live` 0.1.0 et
`@astratra/models` 0.1.0. `create-astratra-app` ne les installe pas.

### Ajoute

- `@astratra/rag` (nouveau) — découpage par paragraphes (titres gardés, groupes
  de paragraphes, chevauchement, identifiants stables), normalisation texte,
  HTML et Markdown, vecteurs injectés marqués de leur modèle (recherche refusée
  entre deux espaces), BM25 + sens fusionnés (RRF pondéré), seuil de similarité,
  plafond par document, reclasseur optionnel borné dans le temps, masquage avant
  tout fournisseur extérieur, vérification des sources (appuyé, contredit, non
  étayé), indexation incrémentale et continue avec verrou injecté.
- `@astratra/live` (nouveau) — appel vocal en direct : session serveur
  (authentification, interruption, délais), adaptateur Gemini Live, mode
  confidentiel local bâti sur `@astratra/voice`, outils de `@astratra/ai` avec
  confirmation à voix haute, garde d'entrée et de sortie, minutes comptées avec
  avertissement, reprise d'une conversation seulement si elle a servi dans la
  fenêtre (30 min par défaut), protocole et états de l'écran d'appel.
- `@astratra/models` (nouveau) — service local de modèles pour VPS sans carte
  graphique (vecteurs, reclasseur, NLI, entités, transcription), jeton comparé
  en temps constant, limites de taille, de file et de mémoire ; client Node qui
  rend des codes au lieu de lever ; générateurs pm2 et systemd.

### Change

- `@astratra/voice` 0.2.0 — chaîne de fournisseurs avec rotation des clés et
  repos après quota, découpage de la voix, garde anti-écho, silence de fin,
  détection des transcriptions douteuses (un texte vide l'est), règle du mode
  confidentiel.
- `@astratra/tooling` 1.3.0 — `astratra publish` (empreinte native, montée de
  version, Google Play par l'API, App Store Connect), `deploy --remote` avec
  retour arrière et message fidèle, `deploy:health`, `dispatch:generate`.
- `@astratra/ai` 1.4.0 — un disjoncteur par fournisseur, masquage réversible
  avant tout fournisseur ou outil extérieur, passages en langue étrangère
  marqués, registre des sources, limite de demandes, fournisseur compatible
  OpenAI.
- `@astratra/credentials` 0.4.0 — sonde de solde des clés (adaptateur Serper).
- `@astratra/privacy` 0.3.0 — consentement versionné par usage, garde à codes,
  client avec copie locale.
- `@astratra/native` 0.3.0 et `@astratra/native-ui` 0.2.0 — sources d'image
  qui n'envoient jamais le jeton hors de l'origine de l'app, image à ses
  proportions, lumière d'attente, visionneuse plein écran.
- `create-astratra-app` 1.6.0 — planchers relevés sur les versions publiées :
  `@astratra/ai` ^1.4.0, `@astratra/native` ^0.3.0 (gabarit mobile), briques
  `@astratra/credentials` ^0.4.0 et `@astratra/privacy` ^0.3.0. À publier en
  dernier.

## 2026-09-28 (32) — extraction de deux assistants d'IA : les souvenirs d'un assistant

Nouveau paquet `@astratra/memory` 0.1.0. Aucun autre paquet ne change de
version ; `create-astratra-app` ne l'installe pas.

### Ajoute

- `@astratra/memory` (nouveau) — les souvenirs par personne d'un assistant
  d'IA, extraits de deux assistants existants (MongoDB et Postgres), le
  meilleur des deux. Un souvenir vit dans un lieu `{ ownerId, scope }` ;
  stockage, vecteurs, modèle, masquage, chiffrement, horloge et identifiants
  injectés, magasin en mémoire fourni avec sa suite de contrat
  (`runStoreContract`) pour prouver un adaptateur. Refus rendus en codes,
  jamais en phrases ; règles de contenu injectées (`patternRule`). Nom d'une
  autre personne refusé en mots entiers ; à la modification, un nom que le
  souvenir portait déjà reste permis. Genre et importance lus comme les
  modèles les envoient (majuscules, alias, « 4 », 4,6). Correction = nouvelle
  version, `undo` rend l'ancienne ; `forget` efface aussi les versions
  antérieures. Rappel hybride sens + mots (même source de vecteurs
  seulement), repli sur les mots et la récence sans vecteurs. Consolidation
  après conversation qui ne lève jamais, une fois par conversation, rejouée
  après un échec. Portrait coupé sur un souvenir entier. Voir, mettre en
  pause, annuler et effacer restent possibles IA coupée
  (`createMemoryHandlers`, `PRIVACY_OPERATIONS`). Outils `remember`,
  `recall`, `update_memory`, `forget` au format du registre de
  `@astratra/ai`.

## 2026-09-25 (31) — native-ui : le bouton en verre s'enfonce sur un ressort

`native-ui` 0.1.1, correctif : rien ne change dans l'API. `^0.1.0` l'installe.

### Corrige

- `@astratra/native-ui` 0.1.1 — `GlassButton` : sur iOS, le contenu sautait
  d'un coup à 0,96 et 0,75 d'opacité au toucher. Il s'enfonce maintenant sur
  un ressort sans rebond et revient sur un ressort court qui dépasse d'un
  cheveu (Reanimated, sur le fil UI). « Réduire les animations » : il pâlit
  seulement. Android garde l'onde seule, comme avant.

## 2026-09-23 (30) — extraction d'une app de prise de rendez-vous : carte d'abonnement et retrait des cartes

`loyalty` 0.2.0 et `wallet` 0.2.0, ajouts seulement : rien ne change pour ce
qui existait. Un caret sur une `0.x` ne franchit pas la mineure : passer à
`^0.2.0` pour en profiter. `create-astratra-app` n'installe aucun des deux,
son plancher ne bouge pas.

### Ajoute

- `@astratra/loyalty` 0.2.0 — `createMonthlyPass` : N passages par mois
  calendaire dans le fuseau du commerce (obligatoire), remise à zéro le 1er
  sans report, quota atteint = passage payant, double scan à confirmer
  (2 minutes par défaut), carte non active = rien de compté. Le QR porte un
  jeton secret à préfixe reconnaissable ; le numéro tapé au comptoir
  (« a901 ») est reconnu. `SCAN_DECISIONS`.
- `@astratra/wallet` 0.2.0 — retirer une carte déjà ajoutée : `voided` dans
  `build()` (Apple la grise), `deactivateObject(id)` chez Google (seul l'état
  est envoyé ; `false` si la carte n'a jamais été créée, rien n'est recréé),
  `forgetPass(passType, serial)` sur les deux registres d'appareils. Le README
  explique l'ordre à respecter côté Apple.

## 2026-09-22 (29) — extraction d'une app de prise de rendez-vous : fidélité et cartes Wallet

`pdf` 0.2.0 (ajouts seulement) ; nouveaux paquets en 0.1.0.
`create-astratra-app` 1.5.1 écrit le nouveau plancher `@astratra/pdf` `^0.2.0`
(un caret sur une `0.x` ne franchit pas la mineure).

### Ajoute

- `@astratra/loyalty` (nouveau) — la carte à tampons : N visites dans une
  fenêtre de temps ouvrent une récompense. La visite récompense ne compte pas
  et remet le compteur à zéro immédiatement ; une récompense ne se réaccorde
  jamais sur le même cycle ; un cycle ouvert un 30 novembre finit fin février,
  pas un 2 mars. Aucune dépendance.
- `@astratra/wallet` (nouveau) — cartes Apple Wallet et Google Wallet.
  Signature `.pkpass` avec identifiant et équipe lus dans le certificat, WWDR
  G4 fourni ; service web du protocole Apple et notification push, jetons
  morts oubliés ; classe et carte Google créées ou mises à jour, lien d'ajout
  signé (JWT RS256) ; contrôle certificat/clé et compte de service avant
  enregistrement ; transport hexadécimal pour qu'un PEM traverse un pare-feu
  applicatif sans l'affaiblir. Registre des appareils en mémoire ou sur une
  connexion Mongoose.
- `@astratra/pdf` 0.2.0 — cartes au format carte bancaire : `imposeCards`
  (planche A4 ou Letter, versos en miroir pour le recto-verso, traits de
  coupe), `drawQrMatrix` (QR vectoriel depuis une matrice), `drawSocialLogo`
  (logos officiels Instagram, TikTok, Snapchat aux couleurs des marques).

## 2026-09-19 (28) — extraction d'une application de gestion scolaire, lot de septembre

Mineures seulement : chaque paquet ajoute des fonctions sans en retirer.
`native` 0.2.0, `i18n-server` 0.2.0, `notify` 0.3.0, `ai` 1.3.0,
`resilience` 0.2.0, `tooling` 1.2.0, `security` 1.11.0, `privacy` 0.2.0,
`core` 1.1.0, `entitlements` 0.5.0 ; nouveaux paquets en 0.1.0.
`create-astratra-app` 1.5.0 écrit ces nouveaux planchers (un caret sur une
`0.x` ne franchit pas la mineure : `^0.2.0` n'installerait jamais `notify`
0.3.0), et `native-ui` demande `native` `^0.2.0`.

### Ajoute

- `@astratra/native-ui` (nouveau) — le kit d'interface mobile : verre liquide
  d'Apple sur iOS, surface visible calibrée sur Android (le flou Android rendait
  un gris dense), boutons en verre, cartes, barres repliables, barre d'onglets à
  pastille, en-tête repliable, Markdown des réponses d'IA. Règles pures dans
  `@astratra/native-ui/logic`.
- `@astratra/app-version` (nouveau) — prévenir d'une nouvelle version en
  magasin. L'annonce est réservée AVANT l'envoi (jamais deux fois), part en
  journée, aux seuls téléphones en retard, et reste éteinte par défaut : un
  poste de développement branché sur la base de production ne notifie personne.
- `@astratra/app-guide` (nouveau) — le guide d'un assistant d'IA généré depuis
  la configuration des écrans. Détection des questions d'usage insensible au
  piège de `\b` devant une lettre accentuée (« À quoi sert »).
- `@astratra/voice` (nouveau) — arguments Piper et ffmpeg, et une version de
  voix dans la clé de cache, partagée entre serveur et téléphone : une nouvelle
  voix invalide l'ancien audio des deux côtés.
- `@astratra/native` — connectivité (un « sans Internet » du système n'est pas
  une panne : nos propres requêtes tranchent), règle des mises à jour à
  distance, cache de médias sur disque borné.
- `@astratra/i18n-server` — langue du courrier distincte de celle de
  l'interface (`emailLang` d'abord, destinataire relu avec ses champs de
  langue), recherche de clés en double et d'objets d'e-mail en dur, garde de
  fuite d'une langue dans une autre.
- `@astratra/notify` — boîte de notifications (pagination, suppression limitée
  au propriétaire avec la même réponse pour « absente » et « à un autre »,
  recalage des non-lues) et catalogue traduit avec corps de push neutre.
- `@astratra/ai` — nettoyage des réponses (aucune clé JSON à l'écran) et
  consignes de mise en forme par surface.
- `@astratra/resilience` — verrou de tâches planifiées en grappe (Redis, Mongo
  ou mémoire) et registre des minuteurs de fond.
- `@astratra/security` — liens signés pour les fichiers privés (demandés par
  chaque lecteur, jamais diffusés, sans « -- » qu'un pare-feu prendrait pour
  du SQL), appareils de connexion et alertes de changement, appareil de
  confiance côté serveur (secret roté, consommé de façon atomique).
- `@astratra/privacy` — suppression de compte en libre-service réversible
  pendant le délai de grâce, et un redactor devenu filtre de données
  sensibles (Luhn, IBAN, jetons, noms de champs normalisés).
- `@astratra/core` — clé idempotente sur les requêtes : réponse rejouée,
  conflit sur un autre corps, une seule exécution concurrente, réponse
  enregistrée avant l'envoi.
- `@astratra/entitlements` — un rôle, un seul titulaire : création,
  promotion et renommage gardés, sentinelle qui compare à l'identité ancrée.
- `@astratra/tooling` — gardes de test : un rôle qui voit sans écrire,
  alignement des faits entre la base de connaissances et le code, mots
  interdits.

### Corrige

- `@astratra/privacy` — le redactor laissait passer `access_token=…`,
  prenait une date, un UUID, une carte ou un IBAN pour un téléphone, et
  recoupait `[API KEY]`.

- `@astratra/notify` — `broadcast` envoyait un abonnement après l'autre : un
  fournisseur lent retenait tous les suivants. C'est ce schéma qui a retardé de
  six heures les poussées Android d'une application en production le 16/09/2026. Envoi désormais en
  parallèle borné (`concurrency`, 10 par défaut) avec une limite de temps par
  envoi (`timeoutMs`), forme de retour inchangée.
- Racine — `npm test` lance désormais tous les espaces de travail, chacun avec
  sa propre configuration. Pour un seul paquet : `npm test -w @astratra/<nom>`.
  `npx jest packages/<nom>` lancé depuis la racine ignore la configuration du
  paquet et prend `__tests__/helpers.js` pour une suite vide : ne pas s'y fier.

## 2026-08-26 (27)

### Corrige

- `create-astratra-app` (`1.4.0`) — **huit planchers de version périmés, tous
  silencieux.** Le générateur écrivait `@astratra/saas-kit: ^1.3.0` : un projet
  généré installait la 1.5.1 publiée, **qui n'a pas les trois nouvelles
  routes**. Le développeur activait `refreshTokens: { enabled: true }` et il ne
  se passait rien — aucune erreur, aucun message.

  Quatre briques portaient en plus un caret sur une version `0.x`, qui **ne
  franchit pas la mineure** : `^0.2.0` n'installe jamais la `0.3.0`. Les
  briques `credentials`, `entitlements`, `payments` et `client` livraient donc
  la version d'avant.

  **Les tests verrouillaient le défaut** : ils affirmaient les numéros en dur,
  donc ils passaient au vert en décrivant l'état périmé. Ils lisent désormais
  les versions de l'espace de travail, et trois nouveaux tests comparent chaque
  plancher écrit — API, briques, gabarit mobile — à ce que le dépôt publie
  réellement. La dérive ne peut plus repasser inaperçue.

## 2026-08-26 (26) — Android

### Corrige

- `@astratra/native` (`0.1.0`) — **`resolveGlassMode()` décrétait « iOS ou une
  imitation », et c'était faux.** Android rend un vrai flou d'arrière-plan ; il
  faut simplement le demander par son nom. Trois réponses désormais au lieu de
  deux : `native` (matériau de la plateforme), `blur` (vrai flou, iOS **et**
  Android), `fallback` (aucun flou disponible, couche translucide assumée).

  Avec `blurPropsFor()`, qui ajoute `experimentalBlurMethod` sur Android — sans
  lui, `expo-blur` s'y affiche en simple voile translucide : il ressemble au
  repli tout en se prétendant flou, ce qui est le pire des trois états puisque
  personne ne remarque l'erreur.

- `create-astratra-app` (`1.4.0`) — trois défauts **propres à Android**, trouvés
  en lançant l'émulateur :

  `elevation` dessinait un **rectangle blanc opaque** à l'intérieur de chaque
  carte. Android dessine l'ombre d'élévation contre un fond opaque ; avec un
  fond translucide il peint un bloc plein derrière toute la vue. Les surfaces
  se séparent maintenant par le flou et la bordure, et l'ombre reste à iOS.

  `expo-notifications` levait une **bannière d'erreur rouge** au démarrage — le
  push distant a été retiré d'Expo Go au SDK 53, et il suffisait d'importer le
  module. Les modules natifs se chargent désormais à la demande dans `load()`
  (c'est précisément à cela que sert le chargeur asynchrone de
  `createPushService`), et les écoutes ne démarrent pas du tout dans Expo Go.

  `GlassPanel` peignait un repli plat hors iOS ; il rend un vrai `BlurView` des
  deux côtés. Le flou est une **couche**, pas le conteneur : mettre le contenu
  dans un `BlurView` le rend lui-même flou sur certaines versions d'Android.

## 2026-08-26 (25) — lot 2

### Ajoute

- `@astratra/client` (`0.2.0`→`0.3.0`) — **le tableau de bord déclaré en
  données.** `createToolCatalog()` : id, chemin, rôles ; l'accès se déclare par
  outil et se refuse par défaut, y compris pour une session à moitié restaurée.
  Un outil sans point d'entrée annonce qu'il a besoin d'un contexte choisi
  d'abord, ce qui évite d'ouvrir un écran vide.

  Ce n'est pas une frontière de sécurité : cela décide ce qu'un écran propose,
  le serveur décide ce qu'il accorde.

  Avec, `readResourceItems()`/`readResourceTitle()`/`readResourceSubtitle()` :
  lire une liste et un nom dans une charge utile qu'on n'a pas dessinée —
  tableau nu, tableau enveloppé, ou objet seul d'une route de détail.

  Et `createSettingsMenu()` — l'ordre est celui déclaré, les groupes vides sont
  omis, et une section inconnue reste **affichée** : mal rangée est cosmétique,
  invisible est une fonctionnalité disparue. Plus `createHomeRoutes()`, dont le
  repli doit rester une page qu'un rôle inconnu a le droit de voir.

- `@astratra/payments` (`0.1.0`→`0.2.0`) — **le côté écran du paiement.**
  `createCheckoutFlow()` décide ce qu'un bouton de plan peut faire, où envoyer
  la personne (`readCheckoutUrl` couvre les noms des différentes passerelles),
  et comment conclure la confirmation. Trois règles nées de plaintes réelles :
  un plan peut être accordé plutôt que vendu ; un compte sans rien à facturer
  doit se l'entendre dire au lieu d'un bouton inerte ; « en attente » n'est pas
  « échoué », le webhook tranchera. Une passerelle non déclarée n'est jamais
  confirmée.

  Avec `readEntityId()`, pour un identifiant qui arrive tantôt brut tantôt
  peuplé — sans quoi une requête part avec « [object Object] » et échoue loin
  de sa cause.

- `@astratra/entitlements` (`0.3.0`→`0.4.0`) — **la liste des invitations,
  côté écran.** `createInvitationBoard()` relit le statut plutôt que de le
  croire : une invitation en attente dont la date est passée est **expirée**,
  quoi qu'en dise le serveur, qui ne bascule le statut qu'à l'ouverture du
  lien. Sans ce calcul l'écran promet un lien déjà mort. Onglets, compteurs,
  urgence, et « terminées » qui réunit expirées, révoquées et échouées.

  `@astratra/native` suit son plancher `@astratra/client` en `^0.3.0`.

### Note

Le lot 2 comptait aussi `documents.ts` (370 lignes) et `messageApi.ts` (168).
**Ni l'un ni l'autre n'est extrait**, après lecture : le premier est du métier
scolaire — délibérations, bulletins, certificats — dont le seul bout générique,
lire un nom, est désormais couvert par `readResourceTitle()` ; le second est
une suite d'appels HTTP liés à des routes précises, dont les parties générales
(`resolveAssetUrl`, dépaquetage de liste) existent déjà dans
`@astratra/native` et `@astratra/client`.

Restent non extraits, faute d'un contrat public qui vaille aujourd'hui :
l'agrégat d'aperçu, les alertes de fraude, les statistiques d'inscription et
l'historique de conversations IA.

## 2026-08-26 (24)

### Corrige

- `create-astratra-app` (`1.4.0`) — **une application générée ne démarrait
  pas.** L'import interne du générateur
  (`import { BRICK_NAMES, … } from './bricks.js'`) avait été recopié dans deux
  fichiers ÉMIS — `api/server.js` et `vite.config.js` — alors que ce fichier
  n'est jamais écrit dans le projet. Tout `npm run dev:api` échouait aussitôt
  sur `ERR_MODULE_NOT_FOUND`.

  Les tests existants ne pouvaient pas le voir : ils vérifiaient que les
  fichiers existent, jamais qu'ils démarrent. Trouvé en lançant réellement une
  API générée pour brancher l'application mobile dessus.

- `create-astratra-app` (`1.4.0`) — **le gabarit mobile portait encore
  l'identité visuelle du projet d'origine.** Cinquante-six couleurs écrites en
  dur dans les composants ignoraient le thème : chaque application livrée à un
  client aurait hérité du même bleu et de la même encre.

  Toutes passent désormais par `constants/theme.ts`, où **deux triplets** —
  l'encre et l'accent — décident de l'ensemble, avec `inkAlpha()` et
  `accentAlpha()` pour les variantes. Changer l'identité d'une application,
  c'est changer deux lignes. Un test du générateur échoue si un littéral
  revient.

- `create-astratra-app` (`1.4.0`) — la tuile du tableau de bord calculait sa
  largeur à partir d'une marge de conteneur écrite en dur. Dans un écran à la
  marge différente, chaque tuile était quelques pixels trop large et deux ne
  tenaient plus sur une ligne — ce qui se lit comme une mise en page cassée,
  pas comme une erreur d'arithmétique. La marge est devenue une propriété.

  Le point après le nom, dans l'en-tête, se retrouvait seul sur sa ligne quand
  l'adresse était longue.

### Ajoute

- `create-astratra-app` (`1.4.0`) — les cinq composants livrés mais non câblés
  le sont enfin : parcours d'inscription en deux étapes (`StepScreen`,
  `BrandBackground`), barre d'onglets et bouton « tout voir » sur le tableau
  de bord, œil d'affichage du mot de passe à la connexion. Un template dont on
  ne voit pas la moitié des pièces n'a livré que la moitié du travail.

  L'URL d'API par défaut perd son suffixe `/api` : l'API générée par ce même
  outil monte ses routes à la racine. Les deux moitiés se parlent maintenant
  sans réglage.

## 2026-08-26 (23)

### Ajoute

- `create-astratra-app` (`1.4.0`) — **le gabarit mobile passe des composants
  d'esquisse au vrai système visuel** : surface de verre (flou natif iOS,
  réfraction Skia, repli ailleurs), en-tête de tableau de bord, cloche, bandeau
  de KPI, tuiles, barre d'onglets, apparition en cascade, écran d'étape
  d'inscription. ~1 100 lignes déjà éprouvées, débarrassées de tout ce qui
  appartenait au projet d'origine — un test du générateur échoue désormais si
  la moindre trace revient.

  Le tableau de bord se déclare **en données** (`constants/dashboard.ts`) :
  changer ce qu'une application affiche est une édition de liste, jamais une
  réécriture d'écran. C'est ce qui permet à un même tableau de bord de servir
  plusieurs rôles.

  La cloche et l'en-tête ne vont plus chercher leurs propres données : l'écran
  possède les données, le composant affiche. C'est aussi ce qui les rendait
  impossibles à rendre dans un test ou un aperçu.

- `create-astratra-app` (`1.4.0`) — **`KeyboardScreen`**, et la fin d'un défaut
  recopié douze fois. Le même montage `KeyboardAvoidingView` + `ScrollView` +
  `Keyboard.dismiss` était collé sur chaque écran à formulaire — avec des
  divergences : `behavior="height"` ici, `undefined` là. Expo règle Android en
  `softwareKeyboardLayoutMode: 'resize'`, donc le système redimensionne déjà :
  ajouter `behavior` par-dessus corrige deux fois la même chose et fait sauter
  la mise en page. Une seule des trois versions était juste ; c'est elle qui
  reste.

### Corrige

- `create-astratra-app` (`1.4.0`) — trois défauts trouvés en faisant tourner
  l'application dans le simulateur, invisibles à la compilation :

  `react-native-reanimated` et son greffon Babel manquaient. Skia les tire, et
  l'échec arrive **à l'exécution** en se présentant comme un paquet absent, pas
  comme un greffon Babel oublié. Un test du générateur le vérifie désormais.

  Le texte des boutons pleins était l'encre foncée sur un bleu saturé —
  lisible sur une capture, refusé par un contrôle de contraste. Un jeton
  `onAccent` sépare l'encre posée SUR l'accent de l'encre du corps de texte.

  Le libellé du bouton « mot de passe oublié » affichait « Se connecter » :
  mauvaise clé de traduction réutilisée.

## 2026-08-26 (22)

### Ajoute

- `@astratra/security` (`1.9.1`→`1.10.0`) — **rester connecté sans laisser
  traîner un passe-partout.** `createRefreshTokenService()` : jeton opaque (pas
  un JWT, donc révocable), rangé **en empreinte** — une base volée ne donne
  aucune session —, **rotation à chaque usage**, et surtout **détection de
  rejeu** : un jeton déjà consommé qui revient signifie qu'une copie circule,
  donc toute la chaîne issue de cette connexion est révoquée. Refuser ce seul
  jeton laisserait le voleur avec celui en cours.

- `@astratra/saas-kit` (`1.5.1`→`1.6.0`) — les trois routes qu'une application
  mobile réclame, éteintes par défaut ou montées seulement si tu fournis de
  quoi les servir :

  `/auth/refresh` (avec `refreshTokens: { enabled: true }`) ; se déconnecter
  révoque désormais aussi la chaîne de rafraîchissement, sans quoi la session
  revenait au renouvellement suivant.

  `/auth/forgot-password` et `/auth/reset-password` (avec `passwordReset.send`
  et `hashPassword`). La réponse est **identique** que l'adresse existe ou non :
  « aucun compte avec cet e-mail » transforme l'écran en annuaire de comptes.
  La réinitialisation **révoque toutes les sessions** — l'étape qu'on oublie,
  alors que la personne est peut-être en train de reprendre un compte volé.

  `/notifications/devices` (POST/GET/DELETE), déclarées **avant** le garde
  d'administration du module : enregistrer son propre téléphone n'est pas un
  acte d'administration. Chaque route est bornée à `req.user.id`, jamais à
  l'identifiant de l'URL.

### Corrige

- `@astratra/security` (`1.10.0`) — **les jetons générés passent de base64url à
  l'hexadécimal, et ce n'est pas cosmétique.** base64url contient `-` : environ
  un jeton sur cent trente portait un `--`, que le WAF de ce même package lit
  comme un commentaire SQL et bloque en 403. La session concernée ne pouvait
  alors **plus jamais** être renouvelée — le client rejoue le même jeton et se
  fait bloquer à chaque fois. Déconnexion apparemment aléatoire, irreproductible.

  Trouvé en exécutant, pas en relisant : le test de bout en bout échouait deux
  fois sur six. Une sonde de 400 tirages a isolé la cause en montrant les jetons
  fautifs, tous porteurs d'un `--`. Deux tests figent désormais l'alphabet.

  Même correction pour les jetons de réinitialisation de `@astratra/saas-kit`,
  qui avaient exactement le même défaut.

  La règle générale : **un identifiant ne doit jamais pouvoir être lu comme du
  contenu.**

- `create-astratra-app` (`1.4.0`) — le gabarit mobile lisait `data.accessToken`
  là où l'API renvoie `data.token`. L'échec était silencieux : la session était
  « enregistrée » avec `undefined`, et la requête suivante partait sans
  authentification.

## 2026-08-26 (21)

### Ajoute

- `@astratra/native` (`0.1.0`) — **la plomberie mobile, sans le moteur
  mobile.** Le package ne charge ni `expo-secure-store`, ni
  `expo-local-authentication`, ni `expo-notifications`, ni `expo-web-browser` :
  il les reçoit. Même règle que le transport de `@astratra/notify`, et même
  bénéfice — 89 tests tournent en Node, sans simulateur ni build natif.

  Session à deux jetons dans le trousseau (jeton d'accès gardé en mémoire : un
  écran de liste faisait douze lectures du Keychain), verrou biométrique,
  service de notifications natives, veille au premier plan, interrupteur des
  réglages, aller-retour de paiement, mode de l'effet de verre.

  Le transport (`createApiClient`) ne réécrit pas le rafraîchissement : il
  branche `@astratra/client`, vol unique et rejeu unique compris. Les trois
  formes d'appel — JSON, flux, binaire — partagent **une** promesse de
  rafraîchissement : un téléchargement et un appel JSON qui butent ensemble sur
  un jeton mort ne renouvellent pas deux fois.

  Trois défauts de la source d'origine sont corrigés, chacun figé par un test :
  un drapeau biométrique restait valide après retrait de l'empreinte du
  téléphone ; un trousseau qui levait faisait échouer le lancement au lieu de
  répondre « pas de session » ; la table de routes des notifications était en
  dur — les règles se déclarent maintenant par autorisation, et une route non
  déclarée est refusée.

- `create-astratra-app` (`1.3.0`→`1.4.0`) — **`--template mobile`** : une
  application Expo Router complète, montée sur `@astratra/native` et
  `@astratra/client`. Splash, accueil public, connexion, mot de passe oublié,
  tableau de bord, réglages, notifications ; i18n en/fr ; thème isolé.

  Le gabarit est un vrai arbre de fichiers copié, pas des chaînes JS écrites
  dans `createProject.js` comme les gabarits API et web : une application Expo
  y aurait ajouté plus de mille lignes de TSX entre guillemets, illisibles et
  impossibles à traiter pour ce qu'elles sont. `gitignore` et `env.example`
  voyagent sous un nom neutre — npm retire un `.gitignore` d'un tarball publié
  — et retrouvent leur point à la copie.

  Ce gabarit refuse les briques : elles sont du câblage serveur, et les
  accepter en silence livrerait des fichiers morts.

- `@astratra/client` (`0.1.0`→`0.2.0`) — `createSupportLink()` : le lien
  d'écriture au support, avec la signature que le support aurait demandée de
  toute façon. Les champs vides sont omis plutôt que rendus en lignes creuses,
  et sujet comme corps sont encodés : un accent ou un saut de ligne non encodé
  tronque le message chez certains clients de messagerie.

- `@astratra/credentials` (`0.2.0`→`0.3.0`) — la lecture de l'état des clés,
  côté écran : `readSpaces()`, `coverageOf()`, `missingKeys()`,
  `firstSpaceToOpen()`, `unlockState()`, `cleanUnlockCode()`. La réponse du
  serveur est lue sans confiance en sa forme, le doute profite au secret — une
  clé sans étiquette `secret` est masquée — et la fenêtre de modification est
  jugée **au moment de la lecture**, jamais à la réception : un écran de
  réglages reste parfois ouvert une heure.

  `@astratra/native` dépend de `@astratra/client` en `^0.2.0`.

## 2026-08-25 (20)

### Corrige

- `@astratra/security` (`1.9.0`→`1.9.1`) — **`createRedisRateLimitStore()`
  tuait le processus au démarrage, Redis disponible ou non.** `rate-limit-redis`
  charge son script d'incrément depuis son propre constructeur, avant que la
  connexion soit ouverte, et n'attend pas la promesse qu'il obtient. La commande
  partait donc contre un client fermé, et le rejet n'appartenait à personne :
  `ClientClosedError`, code de sortie 1, sur une application parfaitement
  configurée. Trois lignes suffisaient à le déclencher :

  ```js
  createRedisRateLimitStore({ redisUrl: 'redis://127.0.0.1:6379' });
  ```

  `sendCommand` attend désormais l'issue de la connexion avant d'envoyer. Quand
  celle-ci échoue, le failover a déjà basculé sur les compteurs mémoire : le
  store Redis ne sera jamais interrogé, sa commande de démarrage n'a plus rien à
  envoyer et se résout sans rien casser. Le comportement de repli est inchangé.

  Les tests existants ne pouvaient pas voir ce défaut : leur `RedisStore` mocké
  était un constructeur qui n'envoyait rien, et leur client mocké acceptait les
  commandes hors connexion. Deux tests de régression reproduisent maintenant les
  deux comportements réels.

  Aucun dépendant à republier : `@astratra/saas-kit` (`^1.7.0`) et
  `@astratra/credentials` (`^1.8.0`) couvrent déjà `1.9.1`, et le plancher
  `^1.3.0` du générateur reste valable.

## 2026-08-25 (19)

### Ajoute

- `create-astratra-app` (`1.2.0`→`1.3.0`) — les onze briques optionnelles
  accessibles à la génération : `--with payments,privacy,notify` ou
  `--with all`. Le générateur ne connaissait que le socle historique
  (`core`, `security`, `ai`, `saas-kit`) ; tout le reste était invisible depuis
  la ligne de commande.
  - Chaque brique demandée fait deux choses : elle s'ajoute aux dépendances, et
    elle écrit un fichier d'exemple CÂBLÉ POUR CE PROJET sous `api/bricks/`
    (ou `web/src/lib/` pour le navigateur) — pas un extrait de README à
    recopier, du code qui compile et qu'on branche quand on veut.
  - Rien n'est ajouté sans qu'on l'ait demandé : la plupart de ces packages
    n'ont aucune dépendance précisément pour qu'on n'en prenne que ce dont on a
    besoin. Sans `--with`, le projet généré est exactement celui d'avant, et un
    test le vérifie.
  - Rien n'est câblé dans `server.js` — même choix que pour `store-mongo`, déjà
    scaffoldé sans être branché : une application fraîchement générée doit
    démarrer sans configuration, pas réclamer six variables d'environnement
    avant son premier `npm run dev:api`.
  - `client` et `prerender` touchent au navigateur ou au build : demandées sur
    le gabarit `api`, elles sont REFUSÉES plutôt que silencieusement ignorées.
    `--with all` prend ce que le gabarit accepte — neuf briques en `api`, onze
    en `fullstack`.
  - Un nom fautif liste les noms valides, et l'échec arrive AVANT qu'un seul
    fichier soit écrit.
  - 3 → 13 tests, dont un qui passe `node --check` sur les onze fichiers
    générés : un exemple qui ne compile pas est pire qu'aucun exemple, on le
    découvre en le branchant et pas en le lisant.

## 2026-08-25 (18)

### Ajoute

- `@astratra/prerender` (`0.1.1`→`0.2.0`) — le sitemap, tiré de la MÊME liste
  que les pages. Un sitemap est presque toujours écrit à la main, sans lien avec
  les routes, et les deux divergent. La panne est silencieuse : le fichier dit à
  un robot d'aller chercher une URL jamais prérendue, l'hébergeur retombe sur
  son repli SPA, et le robot reçoit la PAGE D'ACCUEIL — titre et description
  compris — sous cette adresse. C'est le doublon que `auditPages` détecte du
  côté du rendu ; ceci ferme le même trou du côté de l'annonce.
  - `routes` accepte désormais une ligne de table `{ path, label?, lastmod?,
    changefreq?, priority?, sitemap? }` en plus d'une simple chaîne — l'ancien
    contrat continue de fonctionner tel quel.
  - `sitemap: false` sur une route la prérend sans l'annoncer : une page de
    connexion mérite d'exister pour un robot qui suit un lien, pas une place
    dans un plan de site.
  - L'option `sitemap` vaut `false` par DÉFAUT, délibérément : beaucoup de
    projets ont un `public/sitemap.xml` recopié dans `dist` par Vite, et
    l'écraser sans qu'on l'ait demandé serait une surprise destructrice.
  - Sans génération, un `dist/sitemap.xml` existant est RELU SANS ÊTRE TOUCHÉ et
    ses URLs sans page remontent dans `warnings` — un avertissement et non une
    erreur, car un site sain peut lister des URLs rendues ailleurs (pages
    serveur, contenu dynamique) dont ce prérendu n'a aucune connaissance.
  - `buildSitemap` et `auditSitemap` sont exportées pour qui garde son propre
    pipeline et n'emprunte que le contrôle.
  - 20 → 34 tests, dont trois d'intégration sur un vrai navigateur : le fichier
    écrit, la route exclue du plan mais bien rendue, et le sitemap manuel dont
    les trous sont signalés sans être réécrits.

## 2026-08-25 (17)

### Change — consolidation

Vingt-quatre packages, c'est vingt-quatre README, vingt-quatre changelogs et
vingt-quatre versions à faire vivre. Trois fusions ramènent le compte à vingt,
sans forcer personne à embarquer du code non voulu.

- `@astratra/mailer` est ABSORBÉ par `@astratra/notify` (`0.1.0`→`0.2.0`) —
  désormais « les messages sortants » : e-mail, SMS, notifications poussées.
  Même nature, même architecture (transport injecté, ne lève jamais, absence de
  configuration visible), et personne n'installe l'un sans vouloir l'autre un
  jour. Aucune API ne change : `createMailer`, `renderEmail`, `sanitizeHeader`
  et les autres s'importent maintenant depuis `@astratra/notify`.
- `@astratra/session-client` et `@astratra/offline` sont FUSIONNÉS en
  `@astratra/client` (`0.1.0`) — la plomberie côté client, agnostique de tout
  framework : session, garde de route, règles de mot de passe, file hors ligne.
  Les deux tournent sur l'appareil de l'utilisateur et répondent à la même
  question — le réseau n'est pas fiable et la session peut mourir. Distinct de
  `@astratra/react`, qui reste la couche de liaison React (contextes, hooks).
- `@astratra/invitations` est ABSORBÉ par `@astratra/entitlements`
  (`0.2.0`→`0.3.0`) — inviter quelqu'un AVEC un rôle est le premier acte du
  cycle de vie des droits, et `entitlements` est déjà le pack « qui a le droit
  de quoi ».

Aucune perte : les 824 tests passent tous, et chaque archive s'installe et se
charge toujours dans un projet vierge.

### Laissé séparé, volontairement

- `@astratra/pdf` et `@astratra/closure` se croisent souvent dans un même
  produit (documents de fin de période) mais c'est une coïncidence d'usage : un
  site vitrine peut vouloir le moteur PDF sans jamais clore quoi que ce soit.
- `payments`, `privacy`, `resilience`, `credentials`, `i18n-server` : chacun
  répond à une question distincte et s'adopte séparément. Les fusionner ferait
  installer du code non désiré.

## 2026-08-25 (16)

### Ajoute

- `@astratra/notify` (`0.1.0`, nouveau package) — SMS et notifications
  poussées, transport injecté. Complète le trio d'envois avec
  `@astratra/mailer`.
  - `createSmsSender({ transport, maxLength })` — ne lève jamais ; sans
    transport, l'envoi est une simulation BRUYANTE (étiquetée dans le journal
    et dans le résultat) — une simulation qui a l'air réelle est pire qu'un
    échec, quelqu'un attend un code qui n'a jamais quitté le journal. Numéro
    nettoyé sans prétendre le valider, texte PLAFONNÉ — un texte non borné
    concaténé dans un SMS est la façon dont un bug devient une facture.
  - `createPushSender({ transport, onGone })` — la leçon qui compte : les
    abonnements MORTS. Un 404/410 n'est pas une erreur à journaliser, c'est un
    fait à traiter — l'abonnement est rendu à `onGone` pour suppression, sinon
    la liste n'accumule que des cadavres (envois lents, journaux bruyants,
    fournisseurs qui étranglent). Trois issues jamais confondues :
    delivered/gone/failed ; un abonnement mort n'arrête pas les autres ; un
    élagage qui échoue ne transforme pas un gone en failed ; le statut du
    fournisseur est cherché où qu'il l'ait mis (web-push et les clients HTTP
    ne sont pas d'accord).
  - 17 tests.

- `@astratra/entitlements` (`0.1.0`→`0.2.0`) — `createTenantScope({ field,
  globalRoles })`. Chaque requête
  multi-locataires doit porter le filtre du locataire, et l'oublier une fois
  montre à une école les élèves d'une autre. La règle qui compte : PAS DE
  LOCATAIRE = AUCUNE LIGNE, jamais toutes les lignes — un compte à moitié
  migré reçoit un filtre impossible, pas une requête sans borne, et
  `onMissingTenant` sonne l'alarme parce qu'un utilisateur sans locataire
  mérite mieux qu'un écran vide silencieux. La requête de l'appelant n'est
  jamais mutée ; `canAccess` compare ObjectId et chaîne comme un même
  locataire. 53 → 65 tests.

### Écarte, volontairement

- Un journal auto-masquant : déjà couvert par le redactor de
  `@astratra/privacy`.
- Le rapport de tests HTML et l'orchestrateur de déploiement : trop liés à la
  structure d'un dépôt donné pour tenir un contrat de package stable.
- Le relais temps réel socket.io : trop peu de logique générique au-delà de ce
  que socket.io fournit déjà (rooms par locataire = trois lignes chez
  l'appelant).

## 2026-08-25 (15)

### Ajoute

- `@astratra/invitations` (`0.1.0`, nouveau package) — inviter quelqu'un par
  lien, une fois, pour un temps. Deux propriétés que les implémentations
  maison oublient : le jeton est stocké en EMPREINTE SHA-256 (le garder en
  clair fait qu'une collection qui fuite permet d'accepter toutes les
  invitations en attente), et l'acceptation est une revendication ATOMIQUE (un
  findOne puis update laisse deux acceptations simultanées créer deux comptes ;
  testé au `Promise.allSettled`). Et une nouvelle invitation retire
  les anciennes pour la même adresse — le vieux lien est ce qui ressort d'une
  boîte mail des mois plus tard.
  - Le rôle vient de l'INVITATION, jamais du formulaire. Un échec de création
    de compte marque `failed`, jamais `used` — « utilisée » pour un compte
    jamais né bloque la personne. Inconnue et déjà utilisée répondent le MÊME
    message : lequel des deux est une information qu'un sondeur de jetons n'a
    pas à obtenir. Un envoi raté ne détruit pas l'invitation. Une invitation
    sans e-mail existe (lien à l'écran, QR code). Une révocation consigne qui a
    fermé, et une invitation tranchée répond 409.
  - Rôles injectés, création de compte injectée, envoi injecté (se marie avec
    `@astratra/mailer`), URL injectée. Aucune dépendance à l'exécution.
  - 18 tests.

## 2026-08-25 (14)

### Ajoute

- `@astratra/session-client` (`0.1.0`→`0.2.0`) — deux briques mobiles de
  produits réels, généralisées.
  - `createRouteGuard({ publicSegments })` — la déconnexion remplaçait l'écran
    du dessus par la page de connexion, toute la pile restait derrière :
    quelques « retour » ramenaient sur le tableau de bord, déconnecté mais
    données à l'écran. Deux décisions portent la protection : la liste nomme ce
    qui est PUBLIC et tout le reste est fermé (une liste d'écrans protégés
    échoue en silence — chaque écran oublié part ouvert), et tant que la
    session se restaure rien n'est décidé (rediriger sur l'état transitoire du
    démarrage éjecte un utilisateur connecté à chaque démarrage à froid).
  - `createPasswordRules({ minLength, conditions })` — chaque condition évaluée
    séparément pour que l'écran coche pendant la frappe, des clés de traduction
    plutôt que des phrases, et AUCUNE dépendance pour que le même module tourne
    à l'écran et sur le serveur — les deux copies qui dérivent sont le bug
    d'origine. `strength()` pour la barre de progression, `canSubmit()` pour la
    condition du bouton.
  - Non extrait, volontairement : le test « des trois portes » de joignabilité
    des écrans lit les fichiers du dépôt consommateur — trop spécifique.
  - 13 → 35 tests.

## 2026-08-25 (13)

### Ajoute

- `@astratra/session-client` (`0.1.0`, nouveau package) — rester connecté sans
  que l'utilisateur le remarque. La mécanique finit toujours par exister en
  double — un intercepteur avec file d'attente côté web, une promesse à vol
  unique côté mobile — avec les mêmes pièges résolus deux fois. Transport et
  stockage injectés : axios ou fetch, cookie ou stockage sécurisé natif, même
  logique. Les trois bugs qui reviennent toujours, réglés une fois :
  la RUÉE (cinq 401 simultanés dépensent UN renouvellement — quatre
  renouvellements en course consommeraient un refresh token tourné et
  déconnecteraient l'utilisateur au moment où tout était rattrapable), la
  BOUCLE INFINIE (`/auth/refresh` et `/auth/login` ne déclenchent jamais de
  renouvellement — un mot de passe faux est un mot de passe faux, pas une
  session expirée), et le REJEU UNIQUE (un second 401 avec une session fraîche
  est une permission refusée, pas un problème de jeton). Expiration définitive
  typée `SessionExpiredError`, annoncée une fois, cause conservée. 13 tests.

- `@astratra/offline` (`0.1.0`, nouveau package) — du travail qui survit à la
  perte du réseau. Stockage injecté (IndexedDB, SQLite, AsyncStorage,
  mémoire). Les règles qui rendent une file digne de confiance : l'ORDRE est
  gardé (« présent » puis « absent » doivent atterrir dans cet ordre) ; une
  PANNE arrête le rejeu au lieu de sauter (sauter rejouerait l'histoire dans le
  désordre — sauter est le réflexe naturel, et il est faux) ; un REFUS du
  serveur (4xx) est mis
  de côté visiblement au lieu de tenir la file en otage — et l'utilisateur
  APPREND qu'un travail qu'il croit sauvegardé ne l'est pas. Une action sans
  gestionnaire est refusée à l'entrée plutôt qu'échouée en silence pour
  toujours ; une action d'une ancienne version de l'app est écartée
  visiblement ; deux rejeux concurrents partagent une exécution. 11 tests.

## 2026-08-25 (12)

### Ajoute

- `@astratra/closure` (`0.1.0`, nouveau package) — fermer une période
  volontairement : année scolaire, exercice comptable, saison. Logique pure, aucune
  dépendance à l'exécution — le contrôleur compte, le package juge.
  - `createClosureChecklist(checks)` — la clôture commence presque toujours
    comme une échéance subie : une tâche passe à minuit et ferme quand une
    condition tient, personne ne voit ce qui manque ni ne décide. La liste rend
    la clôture aux humains. La distinction qui porte tout : `blocking` interdit
    de fermer (une délibération non tranchée engage l'avenir d'un enfant), le
    non-bloquant demande seulement d'être VU (un impayé se négocie). Fermer avec
    des impayés est légitime ; le faire sans avoir regardé ne l'est pas — d'où
    la reconnaissance explicite, avec deux règles testées : aucune
    reconnaissance ne passe au-dessus d'un point bloquant, et cocher d'avance ne
    pré-approuve rien.
  - `createArchiveBuilder({ sections, scrubber })` — une archive se transmet et
    parfois s'envoie par courriel : rien de ce qui permet de se connecter à la
    place de quelqu'un n'y entre, et le nettoyage se fait À LA FRONTIÈRE plutôt
    qu'en faisant confiance à chaque lecteur — la seule version qui survit au
    prochain qui ajoute une collection. Une section en échec ne vide pas
    l'archive et elle est NOMMÉE dans `failed` : une archive à laquelle il
    manque une section en silence a l'air complète et ne l'est pas.
  - 21 tests.

## 2026-08-25 (11)

### Ajoute

- `@astratra/resilience` (`0.1.0`, nouveau package) — trois protections contre
  les dépendances qui tombent. Aucune dépendance à l'exécution.
  - `createCircuitBreaker({ failureThreshold, recoveryMs, isFailure })` — une
    dépendance en panne échoue LENTEMENT : chaque appel attend son délai, les
    requêtes s'empilent, une API tierce morte emporte le service avec elle. Le
    disjoncteur remplace l'échec lent par un échec rapide. Durcissement par
    rapport à l'implémentation naïve : la sonde semi-ouverte est SINGULIÈRE —
    laisser passer tous les appelants en attente « pour tester » livre à
    l'heure exacte le troupeau que le disjoncteur devait empêcher. Une sonde
    qui échoue rouvre immédiatement et le délai repart de là. `isFailure`
    distingue la panne de l'erreur métier : un 404 est une réponse, pas une
    panne. `reset()` pour l'opérateur qui vient de déployer le correctif.
  - `createCache({ store, prefix })` — un cache dont l'absence est survivable :
    un store cassé se lit comme une absence, jamais comme une erreur. `remember`
    fait l'idiome cache-aside avec protection contre la ruée : sous concurrence,
    UN calcul par clé, les appelants parallèles attendent la même promesse.
    `null` n'est pas mis en cache (« rien » aujourd'hui ne doit pas masquer
    « quelque chose » cinq minutes) ; l'éviction mémoire retire le moins
    récemment utilisé, pas la plus vieille écriture. Store injecté : Redis en
    production, mémoire ailleurs, même code.
  - `retry(fn, { attempts, shouldRetry })` — recul exponentiel à brouillage
    complet (l'intervalle fixe synchronise les clients en vagues), et par
    défaut tout statut sous 500 n'est PAS relancé : un 400 est faux et le
    répéter ne le rend pas plus juste. `shouldRetry` protège le non-idempotent.
  - 36 tests, dont la sonde unique sous concurrence réelle et la ruée de cache
    avec `Promise.all`.

## 2026-08-25 (10)

### Ajoute

- `@astratra/ai` (`1.1.0`→`1.2.0`) — deux briques pour un agent qui écrit.
  - `createPendingActions({ store, tools, onPending })` — le sas entre un agent
    qui propose et un humain qui dispose. Un agent autorisé à écrire est
    dangereux d'une façon qu'un agent qui répond n'est pas : le mode de panne
    n'est pas la malveillance mais l'assurance — un destinataire plausible, un
    corps plausible, et une vraie famille reçoit un message que personne n'a
    approuvé. Cycle `proposed → approved → executing → executed/failed` avec
    revendication ATOMIQUE de la transition vers `executing` : deux
    approbations simultanées produisent un envoi, pas deux. `dedupeKey` contre
    le modèle insistant, `amend` pour que l'humain corrige le brouillon (la
    correction est consignée), un outil qui RETOURNE une erreur est marqué
    `failed` et jamais `executed` — « Envoyé » pour un message jamais parti est
    le mensonge que le sas existe pour empêcher. Un canal de notification mort
    ne fait pas échouer l'agent. Seuls les outils du catalogue peuvent
    s'exécuter, même si l'enregistrement a été altéré entre-temps.
  - `createDeterministicFallback({ responders, classify })` — répondre quand
    tous les fournisseurs sont tombés : une réponse calculée SANS modèle depuis
    les données déjà là, plutôt qu'un écran vide. La règle d'honnêteté est la
    partie qui compte : chaque réponse de repli se déclare dégradée — servir
    une réponse dégradée comme si de rien n'était apprend aux utilisateurs à se
    méfier des bonnes. L'erreur du fournisseur est transportée et non avalée
    (la gober cacherait la panne à la supervision), et une question sans
    réponse déterministe est déclinée, pas inventée.
  - 18 → 48 tests. `@astratra/saas-kit` n'a pas besoin de bump : sa dépendance
    `^1.0.0` couvre déjà `1.2.0`.

## 2026-08-25 (9)

### Ajoute

- `@astratra/security` (`1.8.0`→`1.9.0`) — deux briques de confiance interne.
  - `createServiceSigner({ secret, maxAgeMs })` — signer les appels entre ses
    propres services. La porte d'entrée est gardée, les couloirs internes ne le
    sont généralement pas : un service appelle l'autre sur le réseau et celui
    qui reçoit fait confiance à ce qui arrive parce que « c'est interne ».
    Extrait de `shared/utils/proxySign`, avec trois durcissements par rapport à
    l'original : un HORODATAGE placé À L'INTÉRIEUR de la chaîne signée (sans
    lui, qui observe un seul appel signé peut le rejouer indéfiniment ; envoyé
    à côté, il serait simplement réécrit), la signature vérifiée AVANT
    l'analyse de la charge utile (analyser d'abord fait tourner le parseur JSON
    sur ce qu'un attaquant a envoyé), et les clés TRIÉES avant signature — un
    service construit `{ id, role }`, l'autre reconstruit `{ role, id }` depuis
    une ligne de base, et `JSON.stringify` produisait deux chaînes différentes
    pour la même donnée, faisant échouer la vérification par intermittence
    d'une façon qui ressemble à un problème réseau. `headers()` /
    `verifyHeaders()` pour le cas courant d'un service HTTP appelant un autre.
  - `createAuditChain({ store })` — un journal qui montre qu'on l'a modifié.
    Chaque entrée porte l'empreinte de la précédente. `verify()` distingue
    `altered` (le contenu ne correspond plus à son empreinte) de `broken` (une
    entrée a été supprimée ou insérée) : un contenu réécrit est une
    falsification, un maillon rompu veut dire qu'on a retiré ou glissé quelque
    chose. Recalculer l'empreinte d'une entrée modifiée ne suffit pas — tout ce
    qui suit pointe encore sur l'ancienne valeur. Seuls les champs signés
    alimentent l'empreinte, donc une colonne ajoutée plus tard ne lit pas comme
    une falsification. L'écriture NE LÈVE JAMAIS : perdre la trace est grave,
    perdre le paiement qu'elle enregistrait l'est davantage.
  - `stableStringify` — la sérialisation à clés triées, partagée par le signeur
    et la chaîne, parce qu'une signature et une empreinte ont le même besoin.
  - 124 → 159 tests. `@astratra/saas-kit` n'a pas besoin de bump : sa
    dépendance `^1.7.0` couvre déjà `1.9.0`.

## 2026-08-25 (8)

### Ajoute

- `@astratra/mailer` (`0.1.0`, nouveau package) — l'anneau autour de l'envoi
  d'e-mails. Deux implémentations très différentes — SMTP d'un côté, API HTTP
  de l'autre — finissent avec exactement les mêmes protections, écrites deux
  fois. Le transport est injecté, aucune dépendance à l'exécution.
  - `createMailer({ channels })` — NE LÈVE JAMAIS. Un e-mail de confirmation est
    la conséquence d'une action, pas l'action : quand la commande est passée et
    l'argent encaissé, une coupure SMTP ne doit pas devenir un 500 qui annonce
    au client que sa commande a échoué. Chaque appel renvoie un résultat.
    Plusieurs canaux nommés, parce qu'un reçu et une alerte de sécurité n'ont
    pas à partager la même réputation d'expéditeur ni les mêmes identifiants.
    Un canal sans identifiants journalise et laisse passer au lieu de faire
    tomber chaque inscription en développement.
  - `sanitizeHeader` / `sanitizeAddress` / `formatSender` — l'injection
    d'en-têtes. Un saut de ligne dans un sujet ne reste pas dans le sujet : il
    le TERMINE et en commence un nouveau, et un formulaire de contact devient un
    relais de spam. Les mots sont conservés et non supprimés (un sujet amputé en
    silence est un bug qu'on ne comprend jamais) ; une adresse invalide est
    refusée et non réparée (un Reply-To malformé casse toutes les réponses sans
    que personne le signale) ; une seule mauvaise adresse dans une liste ne fait
    pas perdre les autres destinataires.
  - `renderEmail` / `renderText` — l'e-mail n'est pas le web : Outlook met en
    page avec Word, Gmail retire les blocs `<style>`, flexbox et grid n'existent
    pas. Tableaux imbriqués et styles en ligne. Le bouton est un tableau, sinon
    il s'effondre en lien nu dans Outlook. La version texte n'est pas une
    politesse : sans elle le message est moins bien noté par les filtres. Tout
    est échappé — un client nommé « Dupont & Fils <SARL> » casse la mise en page
    bien avant qu'on essaie de t'attaquer.
  - `createCaptureChannel()` — tester les e-mails sans serveur mail, et éviter
    qu'un envoi de développement atteigne une vraie personne.
  - 53 tests.

## 2026-08-25 (7)

### Ajoute

- `@astratra/privacy` (`0.1.0`, nouveau package) — droit d'accès, droit à
  l'oubli, anonymisation des journaux. Aucune dépendance à l'exécution.
  - `createAnonymizer({ fields, onAnonymised })` — l'idée centrale : ANONYMISER,
    PAS SUPPRIMER. Les notes d'un élève, les factures d'un client, les fiches de
    paie ont leur propre conservation légale et appartiennent à l'institution
    autant qu'à la personne ; supprimer le compte les emporte ou les laisse
    orphelines. Ce que la loi demande, c'est que la personne cesse d'être
    identifiable. Un champ que la fiche ne porte pas est ignoré, jamais inventé
    — ajouter `parentPhone` à une fiche de salarié créerait une donnée
    personnelle au moment même de l'effacement. Ne sauvegarde pas : la
    persistance et les transactions restent à l'appelant.
  - `createErasureWorkflow({ store, erase })` — l'effacement passe toujours par
    un humain. Personne n'approuve sa propre demande (la barrière existe pour
    une seconde paire d'yeux), une opération irréversible ne s'exécute pas deux
    fois (409), et un effacement en ÉCHEC est enregistré comme échoué, jamais
    comme terminé — consigner une réussite qui n'a pas eu lieu revient à dire à
    un régulateur qu'on a effacé des données qu'on détient toujours.
  - `createDataExporter({ sources })` — ce que tout le monde rate n'est pas
    l'export mais le SILENCE autour. Une source peut déclarer `elsewhere` : le
    fichier nomme alors ce qu'il ne contient pas au lieu de le cacher. Une
    source injoignable ne fait pas couler l'export mais figure dans
    `unavailable`.
  - `createRedactor({ extra })` — e-mails, téléphones, cartes, jetons Bearer,
    secrets en clair, plus les champs dont le NOM suffit. Les motifs ajoutés
    passent AVANT ceux par défaut : le motif téléphone est volontairement large
    et mangerait le matricule d'un motif sur mesure. Le nom du champ est
    conservé, seule la valeur part. La structure est parcourue et non
    sérialisée — passer par JSON réécrit aussi les clés et corrompt le document
    dès qu'un remplacement contient une accolade. Cycles et profondeur bornés.
  - 48 tests.

## 2026-08-25 (6)

### Ajoute

- `@astratra/payments` (`0.1.0`, nouveau package) — le tuyau des webhooks de
  paiement. La même logique se réécrit à chaque intégration, avec les mêmes
  pièges — le meilleur signal qu'elle mérite d'être écrite une fois. Aucun SDK
  importé : la vérification de signature est injectée.
  - `createWebhookHandler({ verify, secret, events, eventLog })` — le code HTTP
    n'est pas décoratif, le prestataire le lit comme une consigne. Signature
    invalide → 400, jamais 500 : relancer ne changerait rien. Gestionnaire qui
    lève → 500, parce que là une relance peut aider. Tout le reste → 200.
  - `unrelated()` — la leçon la moins évidente. Les webhooks sont à l'échelle du
    COMPTE : un point d'entrée reçoit les événements de tous les flux. Répondre
    404 à ce qui n'est pas pour soi fait relancer le prestataire pendant des
    jours et marque la destination défaillante. On acquitte : « reçu, pas mon
    circuit ».
  - `sideEffect(label, fn)` — l'argent est encaissé et la commande confirmée ;
    un e-mail qui échoue ne doit pas provoquer une relance de tout l'événement.
    L'effet de bord échoue seul, et le journal le dit.
  - `secret` accepte une fonction, relue à chaque appel : le secret se change
    depuis une interface sans redémarrage. Se marie avec `@astratra/credentials`.
  - `eventLog` + `createMemoryEventLog()` — les prestataires renvoient les
    événements par conception. Sans mémoire, la seconde livraison reconfirme la
    commande. Un événement en ÉCHEC n'est pas enregistré : la relance doit
    pouvoir fonctionner. Un événement `unrelated` non plus.
  - `createWebhookExemption({ prefix, suffix })` — un seul prédicat partagé par
    le parseur JSON, le CSRF et les gardes. Dans un cas réel, quatre couches
    exemptaient chacune un webhook et en oubliaient un second : chaque paiement
    de ce flux mourait avant d'atteindre le code censé l'enregistrer, sans une
    seule erreur journalisée. Le préfixe ET le suffixe ensemble, parce qu'un
    préfixe seul exempterait toute une section de facturation.
  - 30 tests, dont un qui traverse une vraie pile Express avec CSRF et analyseur
    JSON pour vérifier que les octets signés arrivent intacts.

## 2026-08-25 (5)

### Ajoute

- `@astratra/pdf` (`0.1.0`, nouveau package) — primitives de mise en page pour
  PDFKit, en ne gardant que ce qui n'est pas du métier : la connaissance des
  pièges de PDFKit, pas le dessin des reçus et des bulletins. Aucune dépendance
  à l'exécution — le document est passé en argument, PDFKit reste une
  dépendance de pair optionnelle.
  - `fitText(doc, text, width)` — PDFKit ignore `lineBreak: false` dès qu'une
    largeur est fournie (0.18) et son `ellipsis` ne se déclenche jamais ; le
    texte court alors jusqu'au bord et la ligne suivante écrase ce qui était
    dessous. La coupe se fait donc à la main, par dichotomie, et la mesure porte
    sur la HAUTEUR : le replieur de PDFKit accumule la largeur mot à mot et
    casse une ligne qui tient pourtant au point près selon la mesure d'ensemble.
    « Est-ce que ça tient sur une ligne ? » est la seule question dont la
    réponse correspond à ce qui est dessiné, et elle vaut pour toutes les
    versions.
  - `line()` pour une valeur bornée, `blockHeight()` pour une rangée qui doit
    grandir avec son contenu.
  - `drawTable(doc, { columns, rows, x, y, width, bottom })` — l'en-tête se
    redessine sur chaque page, la hauteur d'une rangée suit sa cellule la plus
    haute (`wrap: true`), et une rangée ne chevauche JAMAIS une coupure de page.
    `bottom` réserve la place de ce qui vient après le tableau, sinon un bloc de
    totaux part sur une page à lui seul. Les colonnes sans largeur se partagent
    le reste du cadre.
  - `keepTogether(doc, { y, height })` — un panneau de synthèse ou une ligne de
    signature coupée en deux est pire qu'une coupure de page avant elle.
  - 36 tests, exécutés sur un VRAI document PDFKit : chaque affirmation porte
    sur ce que PDFKit fait des métriques de police, pas sur notre arithmétique.

## 2026-08-25 (4)

### Ajoute

- `@astratra/i18n-server` (`0.1.0`, nouveau package) — traduire ce que le
  SERVEUR renvoie. Les textes d'interface sont traduits côté client, les
  messages d'erreur ne le sont pas : ils reviennent de l'API et s'affichent tels
  quels, donc une application en anglais répond dans la langue du serveur.
  Aucune langue imposée, aucune dépendance à l'exécution.
  - `createMessageCatalog({ languages, defaultLanguage, messages })` — la CLÉ est
    la phrase source elle-même. Aucun identifiant à inventer, aucun appel à
    modifier, et une phrase absente du catalogue revient dans la langue
    d'origine : c'est exactement le comportement d'avant, donc le package
    s'adopte en production et le catalogue se remplit ensuite, sans régression
    entre les deux. `coverage()` dit où en est chaque langue et nomme ce qui
    manque — un catalogue que personne ne mesure cesse d'être rempli.
  - `createLanguageResolver({ languages, read? })` — lit `Accept-Language`, donc
    aucun client n'a à changer ; une préférence enregistrée l'emporte sur celle
    du navigateur. La première langue RECONNUE gagne, même précédée d'une
    inconnue. Renvoie toujours une langue servie, jamais null ni un tag brut.
  - `createTranslationMiddleware({ catalog, resolver, fields? })` — la
    traduction se fait une fois, à la sortie, en enveloppant `res.json`. Les
    contrôleurs ne changent pas. Seuls les champs nommés sont touchés, JAMAIS le
    contenu de `data` : traduire une valeur la corromprait.
  - `createMessageAudit()` et `collectMessages()` — le test qui refuse les mots
    de développeur et les phrases qui n'apprennent rien. Ce n'est pas un
    contrôle de style : il cherche deux échecs précis, et une fois dans la suite
    de tests la règle se défend toute seule. Le vocabulaire banni est
    configurable, `allow` couvre le cas rare où le mot technique est le plus
    clair.
  - 47 tests, aucune dépendance à l'exécution.

## 2026-08-25 (3)

### Ajoute

- `@astratra/entitlements` (`0.1.0`, nouveau package) — plans, fonctionnalités,
  droits d'accès et commission de plateforme. Aucun plan, aucun rôle, aucun
  taux imposé, et zéro dépendance à l'exécution.
  - `createPlanCatalog({ plans, labels, upgradePath, fallbackPlan })` — un seul
    catalogue consulté partout, au lieu d'une liste de fonctionnalités qui
    dérive entre la page tarifs, le garde d'API et l'interface. Un plan inconnu
    retombe sur le PLUS PETIT plan, pas sur le plus généreux : un plan mal
    orthographié doit donner le moins d'accès possible. `overrides` accorde une
    fonctionnalité hors offre à un compte sans la donner à tous.
  - `createFeatureGuard({ catalog, resolveAccount, isExempt?, isEnabled? })` —
    l'interrupteur de maintenance (`isEnabled`) est vérifié AVANT le plan :
    une fonctionnalité coupée l'est aussi pour l'offre qui la paie, et
    répondre « passez à l'offre supérieure » serait un mensonge.
  - `onError` vaut `'deny'` par défaut : une panne de base ne doit pas ouvrir
    les fonctionnalités payantes. `'allow'` reste disponible pour un produit qui
    préfère rester debout plutôt que fermé — mais comme un choix, pas un oubli.
  - `createStatusGuard({ resolveStatus, blockedStatuses })` — le blocage d'un
    compte entier, distinct de l'entitlement : un compte suspendu perd tout
    d'un coup et n'a pas à s'entendre proposer une montée en gamme.
  - `createCommissionSchedule({ defaultRate, rates })` — commission par plan en
    unités mineures ENTIÈRES ; `commission + net` égale toujours le montant.
  - `createAccessMatrix({ screens, superRoles })` et `except(roles, ...)` — un
    écran absent de la table est FERMÉ, jamais ouvert : l'inverse est la façon
    dont un écran part en production visible par tout le monde. `screensFor()`
    donne directement le menu d'un rôle.
  - 53 tests, aucune dépendance à l'exécution.

## 2026-08-25 (2)

### Ajoute

- `@astratra/credentials` (`0.1.0`→`0.2.0`) — rotation du chiffrement. Le
  package savait ranger des clés chiffrées ; il ne savait pas changer le
  chiffrement, ce qui est la panne silencieuse par excellence : remplacer le
  cipher ne lève rien, le coffre attrape l'échec ligne par ligne, retombe sur le
  `.env`, et toutes les clés cessent d'être utilisées sans le moindre message.
  Ajouté après avoir rencontré exactement ce trou.
  - `createCredentialVault({ previousCipher })` — le coffre lit les DEUX
    générations le temps d'une rotation. Les écritures utilisent toujours le
    cipher courant : c'est ce qui fait converger la migration au lieu de la
    faire osciller. `vault.isRotating()` dit si un repli est en place.
  - `createCredentialRotation({ store, catalog, from, to })` — `plan()` simule
    sans rien écrire, `apply()` migre, `isComplete()` répond à la seule question
    qui compte à la fin : peut-on retirer l'ancien cipher ? Non tant qu'il reste
    quelque chose à migrer OU une valeur qu'aucun des deux ne lit — celle-là est
    déjà perdue, et retirer l'ancien cipher rendrait la perte définitive.
    `unreadableKeys` nomme lesquelles regarder.
  - Le nouveau cipher est essayé EN PREMIER : une valeur déjà migrée est
    reconnue au lieu d'être signalée illisible, donc un passage interrompu se
    relance sans rien abîmer.
  - Un marqueur de débranchement et une valeur déclarée `secret: false` ne sont
    jamais réécrits : l'un deviendrait illisible au lieu de rester débranché,
    l'autre doit rester lisible dans l'interface.
  - 106 tests (88 → 106).

## 2026-08-25

### Ajoute

- `@astratra/credentials` (`0.1.0`, nouveau package) — les clés de service
  (paiement, e-mail, IA) rangées chiffrées dans la base plutôt que dans un
  `.env`, éditables depuis l'interface et effectives sans redémarrage. Extrait
  aucun catalogue de fournisseurs intégré, aucun chiffrement imposé, aucune
  base imposée.
  - `createCredentialCatalog({ spaces, reservedKeys })` — la liste explicite des
    clés que l'interface pilote. Jamais un champ libre : sans catalogue,
    n'importe quel nom de variable pourrait être écrit en base puis lu au
    démarrage. `reservedKeys` refuse celles qui protègent les autres
    (`ENCRYPTION_KEY`, `JWT_SECRET`, `MONGODB_URI`...).
  - `createCredentialVault({ store, catalog, cipher, guard?, onChange? })` —
    base d'abord, `.env` ensuite, `null` si débranchée. Le marqueur de
    débranchement distingue « retirée volontairement » de « jamais saisie » :
    sans lui, la variable d'environnement de secours ferait réapparaître une clé
    qu'on croit débranchée. Ne lève jamais à la lecture — pas de base, cipher
    absent, valeur abîmée : on retombe sur le `.env`, et une clé illisible
    n'emporte pas les autres. `status()` ne renvoie jamais un secret, seulement
    les quatre derniers caractères.
  - `createValueGuard({ keys, decidingKey, livePattern, testPattern })` — le
    poste local et la production partagent souvent le même store ; la règle
    porte sur la VALEUR, pas seulement sur l'environnement. Une valeur réelle ne
    quitte pas la production, une valeur de test circule partout, une valeur non
    classable n'est jamais traitée comme réelle. `decidingKey` fait suivre au
    groupe le sort de la clé qui le classe (une signature de webhook ne dit rien
    d'elle-même mais appartient au même compte que la clé secrète). Permissif
    par défaut : Astratra n'a pas d'avis sur les clés qui déplacent de l'argent.
  - `createEnvHydrator({ vault, guard? })` — remplit et maintient `process.env`
    pour tout le code qui lit ses secrets de façon synchrone. Trois cas, dont
    celui qu'on oublie : une clé retirée de la base restaure la valeur D'ORIGINE
    du `.env`, capturée une seule fois au premier appel. Sans lui, l'ancienne
    valeur resterait figée jusqu'au prochain redémarrage — un service qu'on
    croit débranché et qui continue de fonctionner.
  - `createUnlockChallenge({ store, deliverCode })` — code à usage unique avant
    toute modification : savoir le mot de passe ne suffit pas. Six chiffres via
    `crypto.randomInt`, comparaison à durée constante, jamais conservé en clair,
    cinq tentatives, et demander un nouveau code referme la fenêtre en cours.
    L'envoi est injecté — le package ne connaît pas l'e-mail.
  - `createCredentialsRoutes({ vault, challenge?, authorize })` — routeur Express
    complet. `authorize` obligatoire : ces clés engagent les paiements de toute
    la plateforme, et Astratra ne décide pas qui possède l'argent.
  - Adapters fournis : `createMemoryCredentialStore` / `createMemoryChallengeStore`
    (tests, développement) et `createMongoCredentialStore` /
    `createMongoChallengeStore` (n'importe quelle collection du driver MongoDB,
    sans mongoose ni schéma). `isReady` évite qu'une lecture reste suspendue dans
    la file d'attente de mongoose au lieu de retomber sur le `.env`.
  - 88 tests. Aucun autre package n'a besoin de bump : `@astratra/credentials`
    dépend de `@astratra/core` et n'est référencé par aucun.

### Change

- `eslint.config.js` — `setInterval`/`clearInterval` ajoutés aux globals Node
  partagés, aux côtés de `setTimeout`/`clearTimeout` déjà présents.
- `scripts/verify-package-installation.js` — `@astratra/credentials` ajouté à la
  vérification d'installation des archives.

## 2026-08-20 (2)

### Ajoute

- `@astratra/security` (`1.7.0`→`1.8.0`) — `createRandomCode({ prefix?, tokenBytes? })` /
  `generateUniqueCodes({ quantity, prefix?, isTaken?, maxAttempts? })` :
  génération de codes à usage unique via `crypto.randomBytes` (code promo,
  invitation, carte cadeau...). `generateUniqueCodes` vérifie l'unicité
  contre le store fourni par l'appelant (`isTaken`) AVANT de renvoyer quoi
  que ce soit, jamais après une tentative d'insertion — aucun risque de
  double insertion partielle sur un nouvel essai (boucle de retry ajoutée
  après examen du risque de collision). `@astratra/saas-kit`
  n'a pas besoin de bump : sa dépendance `^1.7.0` couvre déjà `1.8.0`.

## 2026-08-20

### Ajoute

- `@astratra/security` (`1.6.0`→`1.7.0`) — `createRedisRateLimitStore({ redisUrl, prefix? })` :
  construit un store `express-rate-limit` Redis avec un préfixe de clés
  librement choisi par le projet consommateur, pour isoler les compteurs de
  plusieurs limiteurs (connexion, réservation, avis...) sur une même
  instance Redis. Garde la bascule automatique vers un store en mémoire déjà
  présente dans `createApiLimiter`/`createLoginLimiter` si Redis est
  indisponible ou perd la connexion. Aucun nom de domaine métier dans
  Astratra — le préfixe est entièrement défini par l'appelant.
- `@astratra/saas-kit` (`1.5.0`→`1.5.1`, dépendance `@astratra/security`
  resserrée à `^1.7.0`) — aucun changement de comportement propre ; `store`
  était déjà relayé tel quel à `apiRateLimit`/`loginRateLimit`, donc
  `createRedisRateLimitStore` (ci-dessus) s'y branche sans modification de
  code, seule la doc README a été complétée avec un exemple.

## 2026-08-18

### Ajoute

- `@astratra/security` (`1.5.0`→`1.6.0`) — deux primitives qu'aucun projet
  consommateur n'avait à l'origine :
  - `isStrongPassword(password, options?)` — `hashPassword` existait déjà,
    mais rien ne jugeait si un mot de passe valait la peine d'être haché ;
    chaque projet devait écrire sa propre vérification, sans partage
    possible entre projets Astratra. 8 caractères + majuscule + minuscule +
    chiffre + caractère spécial par défaut, chaque catégorie
    individuellement désactivable, pas de message imposé (chaque app garde
    la main sur son propre texte/langue).
  - `createMongoSanitizeMiddleware(options?)` — retire les clés `$...`
    (opérateurs Mongo) et les clés à point (`"a.b"`) de
    `req.body`/`req.query`/`req.params` avant qu'une route ne les transmette
    à un filtre de base de données. Trouvé en construisant un projet
    consommateur réel : une route passait `req.query.date` tel quel dans un
    filtre Mongoose, et `?date[$gt]=` (notation crochet du parseur `qs`
    d'Express) devenait un opérateur Mongo choisi par l'appelant au lieu
    d'une simple chaîne — une injection NoSQL sur une route publique, non
    authentifiée. Mute les objets en place (jamais de réassignation de
    `req.query`, getter seul sur certaines configurations Express/routeur).
- `@astratra/saas-kit` (`1.4.1`→`1.5.0`, dépendance `@astratra/security`
  resserrée à `^1.6.0`) —
  - `createMongoSanitizeMiddleware` (ci-dessus) est désormais monté par
    défaut dans `createSaasApp()`, comme la CSP et les en-têtes de
    sécurité — protège aussi les routes ajoutées via `extendRoutes`, pas
    seulement les routes intégrées du kit. Désactivable via
    `mongoSanitize: false`.
  - Nouvelle option `trustProxy`, relayée à `app.set('trust proxy', ...)`.
    Non définie par défaut (comportement Express inchangé). Trouvé sur le
    même projet consommateur, déployé derrière nginx en production : sans
    ça, Express ignore `X-Forwarded-For` et voit l'IP du proxy pour tous
    les visiteurs — `apiRateLimit`/`loginRateLimit` traitaient alors tout
    le trafic du site comme un seul client, invisible en dev (pas de proxy
    là pour révéler le problème), découvert via le monitoring d'erreurs en
    prod.

## 2026-08-15

### Ajoute

- `@astratra/react` (`0.1.1`→`0.2.0`) — `createApiFetch` attache maintenant
  lui-même le jeton CSRF (cookie `astratra_csrf` → header `x-csrf-token`,
  mêmes noms que `@astratra/security` par défaut) sur toute requête mutante.
  Avant, chaque projet consommateur devait réécrire le même enrobage à la
  main — trouvé en construisant un projet réel qui l'avait fait deux fois
  indépendamment. N'écrase jamais un header explicite ; désactivable via
  `csrf: false` ; noms de cookie/header personnalisables.
- `@astratra/tooling` (`1.0.1`→`1.1.0`) — nouvelle commande
  `astratra audit:deps [--severity=<level>]` : relaie `npm audit --json` et
  échoue (exit code non-zéro, exploitable en CI) si une dépendance a une CVE
  au-dessus du seuil configuré (`moderate` par défaut). Ne réimplémente pas
  la détection — seulement le filtrage par sévérité et un format cohérent
  avec les autres commandes `audit:*`. Trouvé en manquant deux CVE modérées
  sur `react-router-dom` dans un projet consommateur avant de penser à lancer
  `npm audit` à la main.
- `@astratra/security` (`1.4.0`→`1.5.0`) — `createAuthMiddleware` détecte
  maintenant le cas où `req.cookies` est `undefined` **et** qu'aucun jeton
  n'a été trouvé par ailleurs (header `Authorization` compris) : au lieu
  d'un 401 silencieux indiscernable d'une vraie absence de session, il
  transmet une `AuthConfigurationError` explicite à `next(error)`. Trouvé
  en construisant un projet consommateur réel qui montait son propre
  routeur avant `createSaasApp()` sans `cookieParserMiddleware()` — l'auth
  échouait sans aucun indice sur la cause. Le garde-fou ne se déclenche
  jamais pour un flux 100% `Authorization: Bearer` (les cookies ne sont
  regardés qu'en dernier recours). Nouveau : `docs/guides/custom-routes-wiring.md`,
  qui documente le pattern `extendRoutes` recommandé et pourquoi un
  routeur monté en parallèle doit reconstruire cookies + CSRF à la main.
- `@astratra/saas-kit` (`1.4.0`→`1.4.1`) — aucun changement de code, mais
  `createSaasApp()` utilise `createAuthMiddleware` en interne : le
  comportement décrit ci-dessus (erreur explicite au lieu d'un 401 masqué)
  s'applique donc aussi à toute app construite sur le kit. Plancher
  `@astratra/security` relevé à `^1.5.0` en conséquence.
- `@astratra/security` (`1.3.0`→`1.4.0`) :
  - `hashPassword(password)` / `verifyPasswordHash(password, hash)` —
    scrypt (natif à Node, aucune dépendance bcrypt/argon2 ajoutée), sel
    aléatoire par hash, comparaison à temps constant. `verifyPassword`
    reste un callback fourni par l'app ; avant, aucune primitive de hachage
    n'existait, rien n'empêchait un `===` en clair.
  - `createSecurityHeadersMiddleware()` — `X-Frame-Options`,
    `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, et
    `Strict-Transport-Security` (actif automatiquement seulement en
    production). Seul CSP était couvert avant ; ce set standard manquait
    entièrement.
  - `createSecurityAuditLogger()` — journalise une ligne structurée pour
    toute requête qui se termine en `401`/`403`/`429` (configurable),
    peu importe quelle couche (CSRF, WAF, rate limit, JWT) l'a produite.
    Avant, aucune de ces couches ne journalisait quoi que ce soit : une
    tentative d'attaque restait invisible tant qu'elle n'avait pas réussi.
- `@astratra/saas-kit` (`1.3.0`→`1.4.0`) — `createSaasApp()` monte
  désormais `createSecurityHeadersMiddleware` et `createSecurityAuditLogger`
  sans condition (comme CSP), au même titre que les couches déjà actives
  par défaut. `options.securityHeaders` personnalise les en-têtes ;
  `options.securityAudit: false` désactive le journal, un objet ou `true`
  le personnalise (sink de log personnalisé, codes de statut surveillés).
  Plancher `@astratra/security` relevé à `^1.4.0` en conséquence.

## 2026-08-14

### Corrige

- `@astratra/saas-kit` (`1.1.1`→`1.2.0`) — **les routes ajoutées après
  `createSaasApp()` étaient silencieusement inatteignables.**
  `createSaasApp()` termine sa propre pile de middlewares par un
  `notFoundMiddleware`/`errorMiddleware` avant de retourner l'app ; toute
  route enregistrée ensuite par l'appelant (`app.get(...)` sur l'objet
  retourné) tombait donc systématiquement sur ce 404 interne. Ajoute
  `options.extendRoutes(app, { authMiddleware, csrfMiddleware,
  authorizeAdmin, authorizeRoles })`, exécuté avant le 404 — c'est
  désormais la façon documentée d'ajouter ses propres routes. L'app
  retournée expose aussi directement `app.authMiddleware`,
  `app.csrfMiddleware` et `app.authorizeAdmin` pour éviter d'en reconstruire
  des doublons divergents.
- `@astratra/saas-kit` / `@astratra/security` (`1.1.1`→`1.2.0`) — **le
  cookie CSRF n'était jamais amorcé par `GET /auth/me`**, le point d'entrée
  naturel d'une session (utilisé par `getSession` de `@astratra/react`).
  Seuls `/auth/logout` et `/auth/logout-all` montaient `csrfMiddleware`
  parmi les routes `/auth`. Une route métier qui ne monte
  `csrfMiddleware` que sur ses handlers mutants (le réflexe naturel)
  finissait par émettre le cookie CSRF dans la même réponse que la requête
  censée le valider — un 403 `Invalid CSRF token` permanent, puisque le
  client n'avait jamais pu lire le cookie à temps. `@astratra/security`
  ajoute `createCsrfCookiePrimer()` : amorce le cookie sur toute requête
  sûre (GET/HEAD/OPTIONS) sans jamais valider de token. `createSaasApp()`
  le monte désormais globalement, avant toutes les routes — y compris
  celles ajoutées via `extendRoutes`. `createCsrfMiddleware()` et le primer
  vérifient aussi les cookies déjà mis en file sur la même réponse avant
  d'en émettre un nouveau, pour rester idempotents quand les deux
  s'exécutent sur une même requête.
- `create-astratra-app` (`1.0.2`→`1.1.0`) — le template généré n'illustrait
  nulle part comment ajouter une route métier, alors que c'est le tout
  premier geste de quiconque démarre un projet avec le starter.
  `api/server.js` montre maintenant `extendRoutes` avec un exemple concret
  (`GET /api/status`, branché sur l'outil `health_check` d'`api/ai/tools.js`
  — jusque-là scaffoldé mais jamais câblé). `@astratra/store-mongo` et
  `mongoose` passent de `dependencies` à `optionalDependencies` dans le
  `package.json` généré : ils sont scaffoldés (`api/stores/mongo.js`,
  `api/db/mongo.js`) mais pas utilisés par défaut (le projet démarre sur le
  store mémoire), donc plus besoin d'installer un driver Mongo avant d'avoir
  choisi de s'en servir.

### Ajoute

- `@astratra/security` (`1.2.0`→`1.3.0`) — `createCorsMiddleware(options)`.
  Astratra n'a jamais imposé de politique CORS fixe (les origines
  autorisées sont spécifiques à chaque projet) mais ne fournissait aucune
  primitive non plus, poussant chaque consommateur — y compris le template
  `create-astratra-app` lui-même — à réimplémenter sa propre version. C'est
  cette même logique, déjà éprouvée, qui est promue en primitive partagée.
  Origines `127.0.0.1`/`localhost` autorisées par défaut hors production,
  `credentials` activé par défaut (sessions cookie), `OPTIONS` court-circuité
  en 204.
- `@astratra/saas-kit` (`1.2.0`→`1.3.0`) — `options.cors`, monté tout premier
  dans la pile de `createSaasApp()`, avant absolument tout le reste — y
  compris les routes ajoutées via `extendRoutes`. Élimine le piège classique
  où un `app.use(cors())` ajouté après coup sur l'app retournée ne s'applique
  jamais aux routes déjà montées en interne (`/auth`, etc.). Omis, rien ne
  change.
- `create-astratra-app` (`1.1.0`→`1.2.0`) — le template généré utilise
  désormais `createSaasApp({ cors: {...} })` au lieu d'envelopper l'app dans
  un `express()` externe avec un middleware CORS maison
  (`api/config/cors.js`, supprimé). Planchers `@astratra/saas-kit` et
  `@astratra/security` relevés à `^1.3.0` en conséquence ; `express` retiré
  des dépendances directes du projet généré (n'y était plus utilisé
  directement, disponible en transitif via `saas-kit`).
- `@astratra/security` (`1.3.0`→`1.4.0`) — `createMemoryWebauthnStore()`,
  implémentation de référence en mémoire du contrat `WebauthnStore`, même
  motif que `createMemoryUsersStore`/`createMemorySettingsStore` : avant,
  aucun store WebAuthn par défaut n'existait, il fallait en écrire un avant
  de pouvoir simplement essayer le flux. Credentials perdues au redémarrage
  — à remplacer par une vraie base avant la prod. Ajoute aussi
  `createFieldCipher(options)` / `generateFieldEncryptionKey()` : chiffrement
  de champ AES-256-GCM authentifié pour les valeurs qu'une app écrit
  elle-même dans son store — Astratra ne s'intercale jamais entre l'app et
  sa base, donc rien en amont ne pouvait chiffrer les données à sa place.
- `@astratra/ai` (`1.0.2`→`1.1.0`) — `runAgentLoop` accepte deux nouveaux
  callbacks optionnels, tous deux sans effet si omis. `onChunk(chunk)` :
  appelé pour chaque morceau reçu quand `router.ask()` retourne un flux —
  avant, `stringifyModelResponse` consommait le flux en entier avant de
  rendre la main, aucun streaming token par token n'atteignait l'appelant
  même si le provider le supportait. `confirmTool(toolCall, ctx)` : attendu
  avant l'exécution d'un appel d'outil détecté ; retourner `false` annule
  l'exécution sans faire planter la boucle (le modèle reçoit
  `{"denied": true}` comme résultat et peut réagir) — avant, chaque appel
  d'outil autorisé par le rôle s'exécutait automatiquement, sans point
  d'arrêt possible pour une confirmation humaine.
- `@astratra/store-mongo` (`1.0.2`→`1.1.0`) et `@astratra/store-postgres`
  (`1.0.2`→`1.1.0`) — `createMongoMigrationRunner`/
  `createPostgresMigrationRunner` : un runner minimal, pas un DSL ni une
  CLI — étant donné un tableau `{ id, up(client) }`, applique une seule fois
  chaque migration non encore vue, dans l'ordre, suivi par `id` dans une
  table/collection dédiée. La variante Postgres enveloppe chaque migration
  dans sa propre transaction (annulée en cas d'échec) ; la variante Mongo
  ne le fait pas (pas de transactions inter-collections sur un déploiement
  standalone) — voir les README respectifs. Avant, aucun outil de ce type
  n'existait dans le framework : faire évoluer un schéma en prod restait
  entièrement manuel.

## 2026-08-09

### Modifie

- Tous les packages publics (`@astratra/ai` `1.0.1`→`1.0.2`, `@astratra/core`
  `1.0.0`→`1.0.1`, `create-astratra-app` `1.0.1`→`1.0.2`,
  `@astratra/prerender` `0.1.0`→`0.1.1`, `@astratra/react` `0.1.0`→`0.1.1`,
  `@astratra/saas-kit` `1.1.0`→`1.1.1`, `@astratra/saas-kit-ui`
  `1.0.0`→`1.0.1`, `@astratra/security` `1.1.0`→`1.1.1`,
  `@astratra/store-mongo`/`store-postgres` `1.0.1`→`1.0.2`,
  `@astratra/tooling` `1.0.0`→`1.0.1`) déclarent maintenant `engines.node
  ">=20"`, aligné sur la matrice CI. Sans ça, un `npm install` sous Node < 20
  ne loguait un problème qu'à l'exécution, pas à l'installation.
- `@astratra/saas-kit-ui` et `@astratra/react` documentent maintenant
  explicitement leur différence : `saas-kit-ui` reste dashboard complet +
  JWT en mémoire (`Authorization: Bearer`), `@astratra/react` reste
  primitives nues + session cookie `HttpOnly`, sans dashboard imposé — ce
  n'était pas documenté et pouvait passer pour un doublon accidentel entre
  les deux packages.

### Ajoute

- `@astratra/prerender` (`0.1.0`) — première version. Prérendu SEO générique
  pour un site Vite + React : `prerender()` et le binaire `astratra-prerender`
  génèrent un `index.html` par route (Playwright + `vite preview`), préservent
  `dist/_shell.html` vierge pour les visiteurs humains, et exposent
  `transformHtml(html, context)` / `isReady(page, route)` pour l'adaptation par
  projet. `audit.js` vérifie titre et description présents, détecte les titres
  et le contenu visible dupliqués entre pages, et avertit sans bloquer sur un
  contenu trop mince. Couvert par un test d'intégration bout-en-bout (vrai
  Vite, vrai Chromium, 14 cas), en plus des tests unitaires des fonctions pures.
- `@astratra/security` (`1.0.2` → `1.1.0`) — sessions cookie `HttpOnly`
  intégrées : `setSessionCookie`/`clearSessionCookie` (`HttpOnly` toujours,
  `Secure` par défaut sauf `NODE_ENV=development`, `SameSite` configurable),
  `cookieParserMiddleware()` pour peupler `req.cookies` sans dépendance
  `cookie-parser`, et `createCsrfMiddleware()` (double-submit cookie/header,
  bypass automatique pour les clients authentifiés par `Authorization:
  Bearer`). Révocation JWT ajoutée : `createMemoryRevocationStore()` avec
  `revoke`/`isRevoked` (par `jti`, un token précis) et
  `revokeAllForUser`/`isRevokedForUser` (par utilisateur et `iat`, pour un
  logout de tous les appareils). `createAuthMiddleware({ revocationStore })`
  dérive automatiquement `verifySession` si aucun n'est fourni explicitement.
  Tous les nouveaux exports typés dans `index.d.ts` et exercés dans
  `typecheck.ts`.
- `@astratra/saas-kit` (`1.0.2` → `1.1.0`) — `createSaasApp` monte désormais
  `cookieParserMiddleware()` et un `revocationStore` mémoire par défaut,
  branche le CSRF sur toutes les routes mutantes protégées, et ajoute
  `POST /auth/logout` (invalide le token courant) et `POST /auth/logout-all`
  (invalide tous les tokens actifs de l'utilisateur). Dépendance sur
  `@astratra/security` resserrée à `^1.1.0`.
- `@astratra/react` (`0.1.0`) — première version. Primitives React
  optionnelles (`SessionProvider`, `useSession`, `useUser`,
  `usePermissions`, `RequireAuth`, `RequireRole`, `createApiFetch`) pour
  consommer une session cookie `HttpOnly` côté client sans imposer
  d'endpoint, de routing ni de configuration CSRF — ça reste la
  responsabilité de l'application consommatrice. Testé avec
  `@testing-library/react` sur un DOM `jsdom` monté pour `node --test`.

### Corrige

- `@astratra/saas-kit` (`1.0.2` → `1.1.0`) — le cookie de session posé au
  login n'était jamais relu par le middleware d'authentification :
  `createSaasApp` ne montait aucun cookie-parser (`req.cookies` restait
  `undefined`) et le nom de cookie par défaut attendu par `jwtAuth.js`
  (`token`) ne correspondait pas au nom réellement posé
  (`astratra_session`). Un client web se connectant et rappelant une route
  protégée avec uniquement ce cookie recevait `401` au lieu de `200`.
  Confirmé par test de mutation avant correctif (rejeu du cookie posé au
  login contre une route protégée), pas trouvé par simple lecture de code.
- `@astratra/saas-kit` (`1.1.0`) — `POST /auth/logout-all` plantait en `500`
  si un `revocationStore` personnalisé n'implémentait pas la méthode
  optionnelle `revokeAllForUser` (marquée `?` dans l'interface
  `RevocationStore`). Dégrade maintenant proprement (`200`, logout-all
  no-op) quand la méthode est absente. Trouvé par mutation avec un store
  minimal ne fournissant que `revoke`/`isRevoked`.
- `@astratra/security` (`1.0.1` → `1.0.2`) — `createWafMiddleware()` avertit
  désormais (une seule fois par instance, via le logger de `@astratra/core`)
  quand `req.body` vaut `undefined` au moment de son exécution. Monté avant
  `express.json()`, ce middleware inspectait silencieusement une chaîne vide
  à la place du corps réel de la requête : un payload SQLi/XSS dans le body
  passait sans être bloqué, sans la moindre erreur pour le signaler. Trouvé
  en testant manuellement une injection réelle sur une app consommatrice, pas
  par les tests existants — aucun n'exerçait ce cas. README mis à jour avec
  l'ordre de montage requis.
- `@astratra/security` (`1.0.1` → `1.0.2`) — même défaut trouvé et corrigé
  dans `createAccountLimiter()` : sa clé de compte par défaut lit aussi
  `req.body.email`. Monté avant `express.json()`, toutes les tentatives de
  connexion retombaient sur la clé partagée `"unknown"` — plus de limite par
  compte, une seule limite globale partagée par tous les comptes (bypass
  partiel de la protection anti brute-force, et risque de blocage
  d'utilisateurs sans rapport entre eux). Même avertissement une seule fois,
  README mis à jour. Trouvé en auditant systématiquement les autres
  middlewares du package après le premier correctif, pas par hasard.
- `@astratra/saas-kit` — sa dépendance sur `@astratra/security` resserrée de
  `^1.0.1` à `^1.0.2`, pour qu'une installation fraîche ne puisse plus jamais
  résoudre la version vulnérable (`^1.0.1` la couvrait déjà implicitement,
  mais sans l'exiger explicitement). Aucun changement de code dans
  `saas-kit` lui-même — il montait déjà `express.json()` avant le WAF
  correctement.

## [1.0.0] - 2026-08-08

Première version à API publique stable pour les fondations SaaS Astratra.
Cette v1 stabilise les contrats des packages publiables et ajoute
`@astratra/store-postgres` comme second adapter de persistance réel.

Cette version ne promet pas une application finale complète ni une sécurité
garantie : elle fournit une base technique réutilisable, testée et extensible.

### Ajoute

- `@astratra/store-postgres` — adapters PostgreSQL/`pg` pour les contrats
  `usersStore` et `settingsStore`, même contrat que `@astratra/store-mongo`,
  moteur différent. Tests via `pg-mem`, aucune instance Postgres externe
  requise.
- `@astratra/security` — CSP configurable (`createCspMiddleware`), montée
  par défaut dans `createSaasApp` avec une politique `default-src 'none'`
  adaptée à une API JSON.
- `@astratra/saas-kit` — validation d'entrée réelle (`express-validator` +
  `validateMiddleware`) sur `/auth/login`, `POST /users`,
  `PATCH /settings/:key` et `POST /notifications/send`.

### Modifie

- Toutes les versions de packages passent de `0.1.x` à `1.0.0`, y compris
  les plages de dépendances internes (`^0.1.0` -> `^1.0.0`).
- `create-astratra-app` génère désormais des projets qui dépendent des
  packages Astratra en `^1.0.0`.

## [0.1.0] - 2026-08-08

V0 initiale publique des packages Astratra.

### Ajoute

- `@astratra/core` — format de réponse API, gestion d'erreurs, logs,
  request IDs, validation, chargement d'environnement.
- `@astratra/tooling` — CLI `astratra` : `audit:secrets`, `audit:routes`,
  `audit:i18n`, `test`, `deploy`.
- `@astratra/security` — auth JWT avec révocation de session injectée,
  RBAC, rate limiters configurables, WAF, WebAuthn/passkeys avec store de
  credentials injecté.
- `@astratra/ai` — routeur IA multi-provider générique (quotas, cooldown,
  dégradation, état partagé Redis optionnel), registre d'outils, boucle
  minimale d'agent avec appels d'outils.
- `@astratra/saas-kit` — starter `createSaasApp()` assemblant auth, users,
  settings, notifications et résumé dashboard depuis des adapters injectés.
- `@astratra/store-mongo` — adapters MongoDB/Mongoose pour les contrats
  `usersStore` et `settingsStore` utilisés par `@astratra/saas-kit`.
- `@astratra/saas-kit-ui` — dashboard React réutilisable pour démarrer une
  interface SaaS au-dessus de `@astratra/saas-kit`.
- `create-astratra-app` — générateur CLI pour créer une app Astratra avec une
  commande.
- `examples/dashboard-ui` — exemple React + Vite couvrant connexion,
  dashboard, users et settings via `@astratra/saas-kit-ui`.
- CI (`.github/workflows/ci.yml`) exécutant la suite complète sur Node
  20.x/22.x à chaque push et pull request, plus le build du dashboard UI.
- `LICENSE` MIT à la racine et dans chaque package publiable.

### Limites connues

Voir "Limites connues" dans [README.md](README.md) : le dashboard UI de repo
reste un exemple, MongoDB/Mongoose est le seul adapter de persistance réel, le
store de credentials WebAuthn reste une interface, et la boucle d'agent n'a pas
encore de streaming/vision/validation humaine.
