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
| `@astratra/conscience/autoconscience` | P2+ | Types du moteur de réflexion. `runReflection()` vérifie le gouverneur puis refuse : il n'est pas disponible avant P2. |

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
organisation. Cette version stocke les leçons et leur historique ; décider
qu'une leçon est vérifiée revient à l'évaluateur de P2.

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

Cette version exporte les types qu'utilisera le moteur de réflexion
(`ReflectionRun`, `ReflectionFinding`, `CalibrationPoint`, `Hypothesis`,
`Experiment`, `ErrorCostPolicy`, `CounterMetric`, `ToolReliability`,
`DomainCalendar`, `ShadowRun`, `Evaluator`) et `runReflection()`, qui appelle
`assertGovernorReady()` puis lève `not_available`.

À venir, toujours derrière le gouverneur :

- P2, évaluation : calibration, statistiques honnêtes (taille minimale,
  intervalles, droit de ne pas conclure), causalité prudente, contradictions,
  coûts d'erreur, fidélité du raisonnement, fiabilité des outils, calendriers
  métier, contre-mesures, qualité des cycles, classement des retours.
- P3, expériences : rejeu figé à la date qui refuse toute donnée future, bac à
  sable, jeu de tests protégé, surveillance de dérive, abstention, leçons
  devenues tests.
- P4, mode ombre en bac à sable. P5, déploiement versionné, bilan du matin,
  retour arrière. P6, transfert encadré entre agents.

## Tests

```sh
npm test -w @astratra/conscience
CONSCIENCE_TEST_DATABASE_URL=postgresql://localhost/conscience_test npm test -w @astratra/conscience
```

Les tests PostgreSQL ne tournent que si l'URL désigne une base dont le nom
finit par `_test` ; chaque test crée ses propres tables puis les supprime.

## Limites

- Aucun modèle de langage, aucune évaluation et aucun changement automatique
  dans cette version.
- Le gouverneur reconnaît les portées protégées par leurs noms et leurs clés,
  pas en lisant du texte : une proposition doit décrire honnêtement sa cible,
  et tout cas ambigu est rejeté plutôt qu'accepté.
- Le masqueur est le vôtre : le paquet garantit que le texte stocké y est
  passé, pas qu'il a tout trouvé.
