# @astratra/conscience

[English](README.md) | [Français](README.fr.md)

Une mémoire documentée des décisions d'un agent IA, tenue sous un gouverneur
déterministe. L'agent enregistre ce qu'il a décidé, pourquoi, avec quelles
versions et ce qu'il attendait ; les résultats, les corrections humaines et les
leçons s'y rattachent ensuite, avec leurs preuves, et rien n'est jamais écrasé
en silence. Node >= 20, CommonJS, MIT.

« Conscience » et « autoconscience » désignent des fonctions logicielles : un
registre des décisions puis, plus tard, un moteur de réflexion. Elles
n'affirment aucune conscience subjective.

```sh
npm install @astratra/conscience
```

Le paquet a trois entrées :

| Entrée | Phase | Ce qu'elle apporte |
|---|---|---|
| `@astratra/conscience/governor` | P0 | Gouverneur déterministe : constitution, permissions, budgets, isolation, arrêt d'urgence, approbation humaine, journal d'audit. N'importe que des modules de Node : aucun modèle de langage, aucun paquet d'IA (un test parcourt son graphe d'imports). |
| `@astratra/conscience` | P1 | Décisions, prédictions, résultats avec révisions, corrections masquées, leçons avec preuves, modèle de soi, mémoire temporelle, traçabilité, effacement, rétention, garde mémoire. |
| `@astratra/conscience/autoconscience` | P2+ | Évaluation déterministe : calibration, statistiques, conflits, fidélité, fiabilité, calendriers, coûts, contre-mesures et utilité des cycles. |

## Démarrage

```js
const { createGovernor, createPostgresGovernorStore, postgresGovernorSchema } = require('@astratra/conscience/governor');
const { createConscience, createPostgresConscienceStore, postgresConscienceSchema } = require('@astratra/conscience');
const { createRedactor } = require('@astratra/privacy');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(postgresGovernorSchema());
await pool.query(postgresConscienceSchema());

const governor = createGovernor({
  version: '2026-10',
  budgets: { perCycle: 0.5, perAgent: 5, perOrganisation: 20 }, // votre unité de coût, par jour par défaut
  approvers: ['admin-1']                                         // identités humaines fournies par l'application
}, { store: createPostgresGovernorStore(pool) });

const conscience = createConscience({
  governor,                                // obligatoire : refus de démarrer sans lui
  masker: createRedactor(),                // obligatoire : (texte) => texte, un redactor, ou { mask(texte) }
  store: createPostgresConscienceStore(pool)
});

const { decision } = await conscience.recordDecision({
  organisationId: 'org-1', userId: 'user-7', agentId: 'assistant-factures',
  objective: 'Relancer le client pour la facture 42',
  context: { at: new Date(), summary: 'La facture 42 a 10 jours de retard' },
  action: { name: 'send_reminder', kind: 'write', input: { channel: 'email' } },
  alternatives: ['attendre', { name: 'appeler', reason: 'hors des heures de bureau' }],
  expectedOutcome: { description: 'Facture payée sous 7 jours', metric: 'paid', target: true },
  horizon: Date.now() + 7 * 86400000,
  confidence: 0.7,
  permissions: ['invoices:read', 'email:send'],
  versions: { model: 'model-2026-09', tools: { send_reminder: '1.2.0' }, instructions: 'relances-v3' },
  inputSnapshotRef: 'snapshot://invoices/42'
});

// Trois jours plus tard, un capteur métier rapporte le résultat réel.
await conscience.attachOutcome({
  organisationId: 'org-1', decisionId: decision.id, status: 'succeeded', sensor: 'payments',
  provenance: { kind: 'sensor', id: 'payments-webhook' }, observedAt: new Date(), sources: ['payments://tx/991']
});
```

## Gouverneur (`/governor`)

Le gouverneur décide par le code. La même politique et la même proposition
donnent toujours la même réponse ; aucun modèle n'est consulté, et aucun ne
peut rien approuver.

### Politique

`createGovernor(policy, { store, now, onEvent })` vérifie la politique et lève
une `GovernorError` (`policy_missing`, `policy_invalid`) si elle manque ou est
fausse. La politique est gelée ; `getPolicy()` en rend une copie.

| Champ | Par défaut | Sens |
|---|---|---|
| `budgets` | obligatoire | `{ perCycle, perAgent, perOrganisation, periodMs = 1 jour }`, dans votre unité de coût |
| `constitution` | `[]` | Règles `ConstitutionRule` `{ id, description, protectedScope, owner }` ajoutées aux règles par défaut, qu'on ne peut pas retirer |
| `permissions.modifiable` | les quatre types | Ce qu'une proposition peut viser : `instructions`, `threshold`, `tool_description`, `routing` (un sous-ensemble seulement) |
| `automaticChanges` | `'none'` | Seul mode de cette version : toute proposition acceptable attend un humain |
| `isolation` | `'organisation'` | Une opération ne touche qu'une organisation |
| `approvers` | tout humain | Identités humaines autorisées à approuver |
| `halted` | `false` | Arrêt d'urgence statique |

Portées protégées, toujours dans la constitution : `permissions`, `budgets`,
`security`, `privacy`, `constitution`, `approvals`, `isolation`, `governor`. Une
règle ajoutée protège un nom de portée, une cible `type:id`
(`routing:payments`) ou un préfixe terminé par `*`.

### Propositions

```js
const proposal = await governor.evaluatePolicy({
  organisationId: 'org-1',
  target: { kind: 'instructions', id: 'relances', version: 'v3' },
  change: { text: 'Citer le numéro de facture en premier.' },
  justification: 'Moins de questions de suivi.',
  proposedBy: { kind: 'engine', id: 'reflexion' }
});
// proposal.status : 'pending_approval' (raison 'human_approval_required') ou 'rejected'
```

Une proposition est rejetée, avec des codes de raison, quand elle touche une
portée protégée (par sa cible, ses `scopes` déclarées ou n'importe quelle clé
de son `change`), vise un objet hors de la liste blanche, touche une autre
organisation, est mal formée, ou arrive pendant l'arrêt d'urgence. Sa
justification n'est jamais lue. La même proposition deux fois donne un seul
enregistrement ; une autre proposition sous le même identifiant est refusée
(`proposal_conflict`).

`approveProposal(id, { approver, organisationId })` et `declineProposal(...)`
n'acceptent qu'une identité humaine fournie par l'application
(`{ kind: 'human', id }`) ; un modèle, le moteur, une personne hors liste ou
l'auteur de la proposition sont refusés. Approuver enregistre une décision ;
cela n'applique pas le changement (déploiement versionné et retour arrière en
P5).

### Budgets, isolation, arrêt d'urgence, audit

- `authorizeSpend({ id, organisationId, agentId, cycleId, cost })` réserve une
  dépense si elle tient dans les budgets du cycle, de l'agent et de
  l'organisation. Idempotent par `id`. Le magasin PostgreSQL réserve sous un
  verrou consultatif dans une transaction (avec un Pool `pg`) : deux dépenses
  simultanées ne dépassent jamais un budget ensemble.
- `assertSingleOrganisation(...ids)` rend l'unique organisation d'une
  opération ou lève `cross_organisation`.
- `halt({ by, reason, organisationId? })` arrête les opérations réflexives,
  partout ou pour une organisation ; n'importe quel acteur peut le déclencher.
  `resume(...)` exige un humain.
- Chaque décision du gouverneur (évaluation, approbation, refus, dépense,
  arrêt, reprise) est écrite au journal d'audit avant d'être rendue :
  `listAudit({ organisationId })`.

### Contrôle au démarrage

`assertGovernorReady(governor, { organisationId })` lève `governor_missing`,
`governor_invalid` (objet non créé par `createGovernor`),
`governor_unavailable` (magasin injoignable) ou `governor_halted`. Toute
écriture réflexive du paquet l'appelle d'abord.

## Conscience (entrée principale)

`createConscience({ governor, masker, store, now, retention, erasers, onEvent })`
lève une erreur si le gouverneur ou le masqueur manque.

### Enregistrements

| Méthode | Enregistrement |
|---|---|
| `recordDecision(input)` | `DecisionRecord` : organisation, personne, agent, objectif, contexte daté, action, alternatives, résultat attendu, horizon, confiance 0–1, permissions, versions du modèle, des outils et de la consigne, référence d'instantané des entrées |
| `recordPrediction(input)` | Une probabilité rattachée à une décision, avec sa date de résolution |
| `attachOutcome(input)` | `OutcomeRecord` : `succeeded`, `failed` ou `unknown`, capteur, sources, incertitude, facteurs de confusion, provenance. Un résultat plus tardif du même capteur est une nouvelle révision ; les précédentes restent |
| `recordCorrection(input)` | `CorrectionRecord` : seul l'écart masqué, mot à mot, entre le texte proposé et le texte final est gardé, avec sa classe (`factual`, `style`, `objective`, `disagreement`) et le rôle de l'auteur |
| `recordLesson(input)` | `MemoryLesson` : preuves, degré, `validFrom`/`validUntil`, statut, contradictions, remplacements. Écriture réflexive |
| `updateSelfModel(input)` | `SelfModelSnapshot` : capacités testées (chacune avec ses preuves), outils, limites, permissions, provenance. Écriture réflexive |

Chaque enregistrement a un identifiant stable : le vôtre, ou un identifiant
déduit du contenu ; enregistrer deux fois la même chose donne une seule ligne.
Rien n'est jamais modifié : une révision est une nouvelle ligne.

Le texte libre (objectif, contexte, entrée de l'action, résultat attendu,
observations, résumés et notes des leçons, corrections) passe par le masqueur
avant d'être stocké. Utilisez un masqueur déterministe.

### Registre des preuves

Une leçon sans preuve est toujours une `hypothesis` (`statusForced: true` si
un autre statut était demandé). Une preuve qui désigne une décision, une
prédiction, un résultat ou une correction doit exister dans la même
organisation. Cette version stocke les leçons et leur historique ; P2 contrôle
l'effectif et les contradictions avant de vérifier une leçon.

### Lecture

- `getDecision(scope, id)`, `recallDecisions(scope, { agentId, from, to, asOf, withOutcomes })`
- `getOutcomes(scope, decisionId)` : toutes les révisions, avec `revision`, `current`, `supersededAt`
- `getLesson(scope, lessonId)`, `listLessons(scope, { status, validAt, asOf })`
- `getSelfModel(scope, agentId, { asOf })`, `getSelfModelHistory(scope, agentId)`
- `getMemoryTimeline(scope, { axis: 'event' | 'recorded', from, to, asOf, validAt, kinds })` :
  temps de l'événement, temps de l'enregistrement et période de validité.
  `asOf` répond à « que savait-on à ce moment-là ».
- `getLineage(scope, decisionId)` : objectif → action → outils → résultats →
  corrections → leçons.

Une portée est `{ organisationId, userId? }`. Un enregistrement d'une autre
organisation (ou d'une autre personne quand `userId` est donné) reçoit
exactement la même réponse qu'un enregistrement absent.

### Garde mémoire

Le texte stocké est une donnée non fiable : il peut venir d'une personne, d'un
outil ou d'un modèle manipulé. Le paquet ne l'interprète jamais et le
gouverneur ne le lit jamais. Avant qu'un modèle lise des enregistrements,
encadrez-les :

```js
const { frameRecordsForModel } = require('@astratra/conscience');
const bloc = frameRecordsForModel(await conscience.listLessons({ organisationId: 'org-1' }));
```

L'encadrement est celui de `@astratra/ai/guards` (marqueur aléatoire que le
contenu ne peut pas refermer).

### Effacement et rétention

`eraseSubject({ organisationId, userId })` supprime les décisions,
prédictions, résultats, corrections et leçons de la personne, retire les
références à ces données des leçons de l'organisation (une leçon restée sans
preuve redevient une hypothèse) et appelle vos `erasers` pour ce qui est gardé
ailleurs (vecteurs, index, caches, calibrations). Il rend un rapport chiffré.
Avec `retention: { erasure: 'anonymise' }`, les enregistrements restent, sans
la personne.

Rien n'est supprimé par minuterie. `applyRetention({ organisationId })`
supprime les enregistrements plus anciens que `retention.maxAgeDays[type]`, et
seulement pour les types configurés.

## Magasins

Magasins en mémoire (par défaut, perdus à l'arrêt) et PostgreSQL fournis. Le
SQL n'utilise que des paramètres ; le préfixe des tables est un identifiant
vérifié.

```js
postgresConscienceSchema({ prefix: 'astratra_conscience' }) // table <prefix>_records
postgresGovernorSchema({ prefix: 'astratra_governor' })     // <prefix>_proposals, _audit, _spend, _controls
```

### Écrire son propre magasin (MongoDB, ...)

Un magasin de conscience a cinq méthodes sur des enveloppes immuables
`{ kind, id, organisationId, userId, agentId, decisionId, lessonId, eventAt, recordedAt, fingerprint, evidenceRefs, data }` :

| Méthode | Esquisse MongoDB |
|---|---|
| `put(envelope)` | `insertOne` avec un index unique sur `{ organisationId, kind, id }` ; en cas de doublon, rendre le document existant avec `created: false` |
| `get(kind, organisationId, id)` | `findOne` |
| `list(kind, filter)` | `find` sur les champs indexés, `recordedAt <= recordedTo`, `evidenceRefs: ref`, trié par `recordedAt` puis ordre d'insertion |
| `replace(envelope)` | `replaceOne` (effacement et rétention seulement) |
| `remove(kind, organisationId, ids)` | `deleteMany`, rend le nombre supprimé |

`matchesFilter(envelope, filter)` donne la sémantique exacte des filtres.
L'interface du magasin du gouverneur (`GovernorStore` dans les types) demande
un `reserveSpend` atomique (transaction) et un `transitionProposal` en
comparer-puis-écrire (`findOneAndUpdate` sur `status`).

## Autoconscience (`/autoconscience`)

Le cœur P2 est déterministe, sans import ni appel à un modèle de langage.
`evaluateOutcomes()` et son alias `runReflection()` lisent P1 et rendent des
`ReflectionFinding[]`. `createEvaluator({ governor, conscience, ...options })`
lie un évaluateur dont `evaluate({ organisationId, userId?, agentId?, window?, ... })`
évalue une portée. Chaque entrée réflexive vérifie `assertGovernorReady`.
L'évaluation calcule sans écrire de cache ni effectuer de changement automatique.

```js
const { evaluateOutcomes } = require('@astratra/conscience/autoconscience');
const constats = await evaluateOutcomes({
  governor, conscience, organisationId: 'org-1', minimumSample: 30,
  errorCostPolicies: [{ organisationId: 'org-1', domain: 'facturation', falsePositive: 1, falseNegative: 20 }],
  calendars: [{ organisationId: 'org-1', domain: 'facturation', name: 'activité',
    periods: [{ label: 'fermeture', kind: 'closure', from: '2026-12-24', to: '2027-01-02' }] }]
});
```

### Données structurées

Les décisions acceptent `domain` (`general` par défaut), `justification: { claims }`
et `toolTrace: [{ callId, tool, provider?, status, empty?, durationMs, labels? }]`.
La liste des outils déclarés ne remplace pas la trace d'exécution. Les étiquettes
comme `source_verified` proviennent de l'instrumentation de l'application.
Les prédictions acceptent `domain` (hérité de la décision) et `sensor` ; les
résultats acceptent `predictionId`, vérifié dans la même décision et organisation.

Les corrections acceptent la `class` de l'application, prioritaire, ou les
`tags` structurés `fact_changed`, `wording_changed`, `goal_changed`, `opinion_changed`.
Des étiquettes absentes, inconnues ou ambiguës donnent `disagreement`.
Aucun texte libre n'est interprété pour décider de la classe.
Les leçons acceptent `domain`, `subject`, `stance: 'supports' | 'opposes'`.
Deux positions opposées dans la même organisation, personne, agent et domaine
ouvrent un conflit symétrique `to_reassess`. Le résumé seul ne permet pas de
reconnaître une contradiction.

### API de calcul

| Fonction | Résultat |
|---|---|
| `honestStatistics` | Effectifs connus et inconnus, taux, intervalle de Wilson, refus de conclure sous `minimumSample` (30 par défaut) |
| `wilsonInterval` | Intervalle bilatéral ; niveaux 0,90, 0,95 (défaut), 0,99 ; null si aucun résultat connu |
| `calibratePredictions` | Courbe par tranches et agent/domaine, Brier, écart signé de confiance, surconfiance et sous-confiance |
| `scoreErrorCosts` | Faux positifs/négatifs, coût total ; score pondéré = coût total / nombre connu, dans l'unité métier ; seuil de décision 0,5 |
| `checkReasoningFidelity` | `faithful`, `unfaithful`, `unknown` ; chaque étiquette exigée doit correspondre à un appel réussi et non vide ; règle par défaut `source_verified` |
| `toolReliability` | Taux d'erreur, de vide et de lenteur par outil/fournisseur, Wilson et seuils d'effectif, p95 par rang ; durée strictement supérieure à `slowMs` (5000 ms) |
| `calendarConfounders` | `calendar_confounded` dans une période métier `[from, to)` du même domaine |
| `checkCounterMetrics` | Gain de la cible rejeté si une contre-mesure régresse strictement au-delà de `maxRegression`, exprimé en unité absolue |
| `classifyCorrection` | Classe déterministe ; seul `factual` peut étayer une leçon factuelle |
| `evaluateLessonConflicts` | Conflits ouverts, preuves, domaine et dates ; préférence possible selon la force des preuves, jamais clôture par la date seule |
| `reflectionUtility` | Constats utiles + propositions acceptées, pondérés, moins coût pondéré ; bénéfice et utilité nette doivent être positifs |
| `recommendReflectionFrequency` | Réduire après `uselessCycles` cycles terminés inutiles consécutifs (3) ; multiplicateur d'intervalle `reductionFactor` (2) |

Les cycles sans effectifs mesurés de constats utiles ou de propositions acceptées
restent `unmeasured` et ne comptent pas comme inutiles. Le statut inconnu d'un
appel reste hors du dénominateur du taux d'erreur ; les taux de vide et de lenteur
décrivent les valeurs de vide et de durée réellement rapportées.

Les inconnus restent conservés, hors des dénominateurs succès/échec et des
scores de Brier/coût. L'évaluateur prend la dernière prédiction par décision/domaine
(date, puis identifiant), et le résultat courant du capteur ou du lien explicite.
Un résultat absent, ambigu ou observé avant la prédiction reste inconnu.
Une décision ne compte qu'une fois par domaine ; le calcul de calibration direct
refuse les doublons. Chaque tranche a son propre seuil d'effectif. Les intervalles
restent affichés pour les petits échantillons non nuls, mais `insufficient_data`
refuse toute inférence. Les mesures sont descriptives.

Chaque constat conserve preuves, effectif, intervalle, statut, confiance,
hypothèses concurrentes et facteurs de confusion. `causality` vaut toujours
`not_established` : résultat et fidélité de la méthode restent distincts.
Un succès isolé ne crée aucune règle générale. `confidence` représente la
confiance d'observation fournie ou le niveau de l'intervalle, jamais la
probabilité qu'une hypothèse causale soit vraie.

### Vérification et arbitrage des leçons

`createConscience({ minimumSample: 30, ... })` fixe le plancher de vérification.
Une leçon peut exiger un seuil supérieur, jamais abaisser ce plancher.
L'effectif est calculé sur les **décisions distinctes** représentées par des
résultats courants connus ou des corrections factuelles du domaine et de l'agent.
Les références externes, décisions et prédictions seules n'augmentent pas cet
effectif ; les inconnus, anciennes révisions et doublons sont exclus.
Une leçon factuelle citant une correction de style, d'objectif ou de désaccord
reste une hypothèse. Preuve, effectif suffisant et absence de conflit sont tous
nécessaires pour `verified` ; conflit ouvert : `to_reassess` ; sinon : `hypothesis`.
Ce statut qualifie la suffisance des preuves, pas une causalité.

`conscience.resolveLessonConflict({ organisationId, userId?, winnerId, loserId, evidence })`
arbitre explicitement avec un effectif factuel suffisant du même domaine :
la leçon adverse est retirée, une révision de la gagnante est ajoutée.
Chaque écriture passe par `assertGovernorReady`. Toutes les anciennes révisions
restent. `getLesson().current` et `listLessons()` réévaluent preuves et conflits,
y compris après un résultat tardif inconnu ou des écritures concurrentes.
`storedStatus` expose le statut enregistré ; `history` garde les révisions
enregistrées. `asOf` utilise les preuves et résultats connus à cette date.

Les constats sont recalculés : effacer leurs sources les retire des évaluations
suivantes. Pour un magasin de constats propre à l'application, enregistrer un
effaceur. `window` filtre les dates des décisions ; ce n'est pas le rejeu temporel
P3. Une sélection atteignant 1000 décisions lève `evaluation_limit` : fournir
`decisionIds` explicitement pour une sélection plus grande sans troncature.

P3 (expériences), P4 (mode ombre), P5 (déploiement) et P6 (transfert) restent hors
P2. L'évaluation ne crée ni planificateur ni transport de modèle ni déploiement.

## Tests

```sh
npm test -w @astratra/conscience
CONSCIENCE_TEST_DATABASE_URL=postgresql:///conscience_p2_test npm test -w @astratra/conscience
```

Les tests PostgreSQL ne tournent que si l'URL désigne une base dont le nom
finit par `_test` ; chaque test crée ses propres tables puis les supprime. Une base de test
absente est créée avec `createdb` si permis ; sinon les tests d'intégration
sont ignorés avec une raison explicite, sans afficher l'URL.

## Limites

- Aucun modèle de langage ni changement automatique ; P2 évalue uniquement
  des preuves structurées.
- Le gouverneur reconnaît les portées protégées par leurs noms et leurs clés,
  pas en lisant du texte : une proposition doit décrire honnêtement sa cible,
  et tout cas ambigu est rejeté plutôt qu'accepté.
- Le masqueur est le vôtre : le paquet garantit que le texte stocké y est
  passé, pas qu'il a tout trouvé.
