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
| `@astratra/conscience/governor` | P0, P5 | Gouverneur déterministe : constitution, permissions, budgets, isolation, arrêt d'urgence, approbation humaine, journal d'audit ; et (P5) matrice d'approbations, changements versionnés réversibles avec déploiement progressif, retour arrière, bilan du matin. N'importe que des modules de Node : aucun modèle de langage, aucun paquet d'IA (un test parcourt son graphe d'imports). |
| `@astratra/conscience` | P1 | Décisions, prédictions, résultats avec révisions, corrections masquées, leçons avec preuves, modèle de soi, mémoire temporelle, traçabilité, effacement, rétention, garde mémoire. |
| `@astratra/conscience/autoconscience` | P2, P3, P4 | Évaluation déterministe : calibration, statistiques, conflits, fidélité, fiabilité, calendriers, coûts, contre-mesures et utilité des cycles ; expériences et vigilance (P3) ; mode ombre (P4). |

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
cela n'applique jamais le changement à lui seul (voir Approbations et
Changements réversibles ci-dessous).

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
  arrêt, reprise, enregistrement, candidate, déploiement, promotion, retour arrière,
  constat) est écrite au journal d'audit avant d'être rendue :
  `listAudit({ organisationId })`.

### Approbations (matrice, double approbation, expiration)

L'approbation est décidée par la politique, pas par celui qui propose :

```js
createGovernor({
  budgets: { /* ... */ },
  approvers: ['admin-1', 'admin-2', 'rev-1'],
  approvals: {
    roles: { 'admin-1': ['owner'], 'admin-2': ['owner', 'reviewer'], 'rev-1': ['reviewer'] },
    matrix: { instructions: { roles: ['owner', 'reviewer'] }, routing: { roles: ['owner'], approvals: 2 } },
    floors: { routing: 'high' },   // risque minimal d'un type (« medium » par défaut)
    doubleApprovalFrom: 'high',    // à partir de ce risque, deux personnes distinctes
    distinctRoles: false,          // true : les deux doivent avoir des rôles différents
    expiresInMs: 7 * 24 * 3600e3,  // validité d'une approbation
    declineReasons: ['too_costly'] // ajoutés au registre
  }
});
```

- Le risque d'une proposition est le plus haut entre le plancher de son type
  et le `risk` qu'elle déclare (`low`, `medium`, `high`, `critical`) : qui
  propose peut relever l'exigence, jamais l'abaisser.
  `proposal.requiredApprovals` dit combien de personnes sont nécessaires (1, ou
  2 à partir de `doubleApprovalFrom`, ou plus selon la matrice).
- `approveProposal(id, { approver, organisationId, role? })` enregistre une
  approbation. La proposition reste `pending_approval` tant qu'elle n'a pas
  assez d'approbations valides de personnes distinctes dont la matrice admet
  les rôles ; la même personne n'approuve pas deux fois ; personne n'approuve
  sa propre proposition.
- Une approbation expire après `expiresInMs`. Une approbation partielle expirée
  ne compte plus ; une proposition approuvée que personne n'a mise en candidate
  à temps passe à `expired` (`expireApprovals({ organisationId })` les balaie)
  et doit être reproposée.
- `declineProposal(id, { approver, organisationId, reasonCode })` exige un code
  du registre (`DECLINE_REASONS` : `insufficient_evidence`, `risk_too_high`,
  `not_needed`, `wrong_scope`, `poor_tests`, `no_rollback_plan`,
  `conflicts_with_policy`, `bad_timing`, `duplicate`, `other`, plus les codes
  de la politique). Le texte libre va dans `note` et n'est jamais interprété.
- `listRejectionSignals({ organisationId, since?, origin?, reasonCode? })`
  rend tous les refus, par une personne (`origin: 'human'`) ou par le code
  (`'governor'`), sous forme de codes, pour les phases d'évaluation et
  d'expériences.
- Invariant : rien n'est appliqué parce qu'un modèle l'a approuvé. L'approbation
  exige une identité humaine ; la mise en candidate relit les approbations
  stockées et refuse tout le reste (un enregistrement forcé à `approved`, une
  approbation de modèle, un contenu modifié, une portée protégée, une
  approbation expirée). `verifyApprovalInvariant({ organisationId })` audite le
  magasin à la recherche de tels cas.

### Changements réversibles

Les objets qu'une proposition peut changer (consignes, seuils, descriptions
d'outils, règles de routage) sont versionnés. Le journal d'audit garde qui,
quoi, quand et la version avant et après.

```js
await governor.registerObject({ organisationId, kind: 'instructions', id: 'reminders', content: { text: '...' }, by: { kind: 'human', id: 'admin-1' } }); // v1, stable
const proposal = await governor.evaluatePolicy({ organisationId, target: { kind: 'instructions', id: 'reminders', version: 'v1' }, change: { text: '...' }, proposedBy: engine });
await governor.approveProposal(proposal.id, { approver: human, organisationId });
await governor.stageChange(proposal.id, { organisationId, by: engine });   // candidate v2, exposition 0 %
await governor.deployChange({ organisationId, kind: 'instructions', id: 'reminders', percentage: 10, by: human });
const { versionId, content } = await governor.resolveVersion({ organisationId, kind: 'instructions', id: 'reminders', targetingKey: userId, attributes: { cohort: 'beta' } });
await governor.deployChange({ /* ... */ percentage: 100, by: human });
await governor.promoteChange({ /* ... */ by: human });                      // v2 devient stable
await governor.rollbackChange({ /* ... */ by: anyActor, reason: 'metrics fell' }); // retour à v1, à l'identique
```

- `stageChange` crée une candidate seulement à partir d'une proposition qu'un
  humain a approuvée, et revérifie tout à cet instant : empreinte, portées
  protégées, liste blanche, organisation, approbations (humaines, distinctes,
  rôles, nombre, expiration) et que la proposition vise la version stable
  actuelle (`stale_base`). Une candidate par objet. Mettre deux fois la même
  proposition en candidate donne la même candidate.
- L'exposition grandit sur décision d'un humain (`deployChange`,
  `promoteChange`) : `percentage` (0 à 100) et/ou `cohorts`. Les cohortes disent
  qui est éligible, le pourcentage quelle part d'entre elles. Les seaux
  utilisent le hachage de `@astratra/flags` (`rolloutBucket` est identique à son
  `bucket`) : un utilisateur reste dedans ou dehors de façon stable, et
  augmenter n'écarte personne. La promotion exige 100 % de tout le monde.
- Pour confier la décision à un vrai service de drapeaux, passer `flags` à
  `createGovernor` : tout objet avec `resolveBoolean(key, fallback, context)`,
  comme un fournisseur `@astratra/flags`. Ce paquet ne l'importe pas.
  `exportFlagRules({ organisationId })` donne les règles à charger dans son
  `createMemorySource`. Un service de drapeaux en panne sert la version stable.
- `rollbackChange` marche à tout moment, pour tout acteur identifié, même à
  l'arrêt : il écarte la candidate, ou rétablit la version qui était stable
  avant la dernière promotion (le même enregistrement, pas une copie). Il est
  journalisé.
- Arrêt d'urgence : `halt()` ramène aussi toutes les candidates de sa portée
  (globale, ou une organisation) à leur version stable et rend ce qu'il a
  annulé. À l'arrêt, `resolveVersion` sert la stable et rien ne peut être mis
  en candidate, déployé ni promu. `resume()` ne ramène pas de candidate.
- `listVersions`, `getObject`, `listObjects` et `getChangeHistory` lisent l'état.

### Bilan du matin

`recordFinding({ organisationId, code, severity, subject, ... })` reçoit les
constats d'un cycle de réflexion (codes et nombres, pas de phrases).
`morningReport({ organisationId, since, until? })` rend des données brutes
qu'une interface affiche, les mêmes pour le même magasin et la même période :

| Champ | Contenu |
|---|---|
| `findings` | Constats reçus dans la période, comptés par gravité |
| `pendingProposals` | En attente d'approbation : risque, approbations requises et valides, rôles admis, tests, plan de retour arrière |
| `approvedAwaitingStage` | Approuvées, pas encore en candidate : expiration, `valid`, `expired` |
| `rollouts` | Candidates en cours de déploiement : versions stable et candidate, pourcentage, cohortes |
| `rejections` | Refus récents sous forme de signaux avec raison codée |
| `rollbacks` | Retours arrière et annulations d'urgence récents |
| `counts` | Totaux pour un en-tête |

Le bilan ne recopie aucun texte libre de l'auteur, seulement des identifiants,
des codes, des nombres et les objets `tests` et plan de retour arrière fournis.
Tout est lu dans une seule organisation.

### Réglages distants (tableau de bord)

`createRemoteSettings` permet à un tableau de bord d'allumer ou d'éteindre
l'agent, de tirer ou de lever son arrêt d'urgence, de nommer ses approbateurs et
de régler sa réflexion, et aux humains d'y approuver ou refuser les
propositions. Le gouverneur reste seul juge : l'adaptateur transforme les
réglages en options du gouverneur et soumet chaque décision humaine par
`approveProposal` / `declineProposal`. Il n'importe que ce dossier : vous lui
passez la fonction qui lit les réglages.

```js
const { createRemoteSettings, createPostgresGovernorStore } = require('@astratra/conscience/governor');

const remote = createRemoteSettings({
  read: () => tableau.lireReglages(),          // votre client, avec son propre cache
  policy: politiqueLocale,                     // constitution, permissions, PLAFONDS de budget
  organisationId: 'org-1',
  storage: { load: () => cache.lire(), save: (s) => cache.ecrire(s) } // facultatif : survit aux redémarrages
});
const store = createPostgresGovernorStore(pool);

setInterval(async () => {
  await remote.refresh();                      // ne lève jamais
  const governor = remote.governor({ store }); // à redemander à chaque fois : refait quand la politique change
  await remote.sync(governor);                 // arrêt d'urgence distant, appliqué tout de suite
  const resultats = await remote.applyDecisions(governor, await tableau.lireDecisions());
  // renvoyer les résultats (applied, already_applied, refused + code ; failed = réessayer plus tard)
}, 60_000);

if (remote.reflectionDue()) await lancerCycle({ cycleId: remote.reflectionCycleId() });
```

Réglages (`conscience-settings/1`) : `version`, `enabled`, `halted`,
`resumedBy`, `approvers`, `reflection { automatic, hour, timeZone }`,
`cyclesPerDay`. Règles :

| Situation | Effet |
|---|---|
| Source muette, lente ou invalide | Le dernier réglage valide reste (`source: 'last_known'`), en mémoire ou dans `storage` |
| Aucun réglage valide jamais reçu | Tout éteint : désactivé, gouverneur arrêté, aucun approbateur |
| `version` plus ancienne que celle en vigueur | Ignorée (`stale_settings`) |
| `halted: true` | Appliqué aussitôt, même dans une réponse invalide ou périmée ; `sync` tire l'arrêt d'urgence du gouverneur (les candidates reviennent à la version stable) |
| Arrêt levé | `sync` ne relâche qu'un arrêt qu'il a tiré, et seulement au nom de l'humain de `resumedBy` ; un arrêt tiré par quelqu'un d'autre reste |
| `enabled: false` | Gouverneur arrêté ; `reflectionDue()` vaut faux |
| `cyclesPerDay` | `perAgent` et `perOrganisation` deviennent `min(local, cyclesPerDay × costPerCycle)`, jamais au-dessus des valeurs locales |
| `approvers` | Les approbateurs du gouverneur ; dans la liste locale `approvers` quand elle existe |
| Tout le reste (`constitution`, `budgets`, `permissions`, `approvals`…) | Jamais appliqué, listé dans `current().ignored` |

`applyDecisions` se rejoue sans risque : une décision que le gouverneur a déjà
revient en `already_applied`, une approbation n'est donc jamais comptée deux
fois. Approbateurs, arrêt, portées protégées, rôles et expiration restent
vérifiés par le gouverneur.

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
postgresGovernorSchema({ prefix: 'astratra_governor' })     // <prefix>_proposals, _audit, _spend, _controls, _objects, _versions, _findings
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
un `reserveSpend` atomique (transaction), un `transitionProposal` en
comparer-puis-écrire (`findOneAndUpdate` sur `status`, et sur le nombre
d'approbations quand un `guard` est donné), un `updateObject` en
comparer-puis-écrire sur `revision`, et des `createObject`, `putVersion` et
`putFinding` qui n'insèrent qu'une fois.

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

P3 (expériences) et P4 (mode ombre) sont décrites dans leurs propres sections plus bas.
L'évaluation elle-même ne crée ni planificateur ni transport de modèle ni déploiement.

- P3, expériences : rejeu figé à la date qui refuse toute donnée future, bac à
  sable, jeu de tests protégé. Surveillance de dérive, suivis, abstention,
  adversaire nocturne, revue multi-rôles et leçons devenues tests sont décrits
  dans « P3 · vigilance (2/2) » plus bas.
- P4, mode ombre en bac à sable : voir « P4 · mode ombre » plus bas.
- Seule la P6 (intégration et transfert encadré entre agents) reste hors de ce paquet.

La P5 (gouvernance avancée) est dans l'entrée du gouverneur : voir plus haut.

## P3 · expériences (1/2)

Cette première moitié couvre 02/35 (rejeu temporel), 32 (outils simulés), 36
(jeu final protégé) et 16 (laboratoire pré-enregistré). Le paquet reste en
1.0.0, non publié. Les cinq API et leurs opérations ultérieures passent par
`assertGovernorReady`, dans une seule organisation. Le cœur de calcul n'importe
aucun modèle de langage et n'utilise jamais de texte généré pour juger un
résultat. Les autres fonctions P3 appartiennent à la seconde moitié.

| API | Contrat |
|---|---|
| `replayDecisions({ governor, conscience, organisationId, proposal, decisionIds \| window, asOf, snapshots?, tools? })` | Reconstruit les entrées, résultats et révisions de leçons connus **à chaque décision** ; `asOf` fixe la borne extérieure. Donnée future détectée : `future_data`. Rend `purpose: 'compatibility_only'`, `provesProgress: false`, `causality: 'not_established'`. |
| `createSandbox({ governor, organisationId, tools })` | Remplace chaque implémentation, même une lecture réelle à effets secondaires. Lecture : `response`, `recordings: [{ input, output }]`, ou inconnu simulé. Écriture/confirmation : intention journalisée seulement. Une fonction réelle seule est traitée prudemment comme écriture. `tools[name](input)` et `getJournal()` n'appellent jamais l'outil réel. |
| `createHoldout({ governor, organisationId, cases })` | Le code de préparation reçoit un objet opaque : `evaluate`, `getAccessLog`, et `read` toujours refusé. Propriétés, énumération et sérialisation ne révèlent aucun contenu (`holdout_protected`). Une seule évaluation finale, y compris en concurrence. |
| `proposeExperiment({ governor, organisationId, hypothesis, metrics, protocol, thresholds, agent, holdout, tools? })` | Copie et gèle avant toute exécution l'hypothèse, les métriques, le protocole, les seuils, l'horodatage et l'empreinte SHA-256, avec empreintes du candidat et des outils. Réserve un jeu final inutilisé. |
| `runExperiment({ governor, organisationId, experiment })` | Exécute une seule fois le candidat enregistré : développement, validation, puis jeu final protégé. Modifier protocole, métriques, seuils, hypothèse, candidat ou outils est refusé (`protocol_changed`), même après l'exécution. |

```js
const { createHoldout, proposeExperiment, runExperiment } = require('@astratra/conscience/autoconscience');
const portée = { governor, organisationId: 'org-1' };
// Trois jeux séparés, préparés hors du moteur de réflexion.
// Chaque cas : { id, input, expected }. Ne jamais lui donner casFinaux.
const holdout = await createHoldout({ ...portée, cases: casFinaux });
const expérience = await proposeExperiment({
  ...portée, hypothesis: 'Le candidat atteint le seuil d’exactitude enregistré',
  agent: (entrée) => entrée,
  metrics: [{ name: 'accuracy', kind: 'exact_match' }],
  thresholds: { accuracy: 0.9 },
  protocol: { development: casDéveloppement, validation: casValidation,
    minimumSample: 30, level: 0.95, timeoutMs: 1000 },
  holdout
});
const résultat = await runExperiment({ ...portée, experiment: expérience });
// décision : supported | refuted | inconclusive (« non concluant »)
// stages.holdout : métriques agrégées, sans cas, réponses ni journal d'outils.
```

Les métriques comparent les valeurs JSON par le code (`exact_match`), avec
`outputKey` / `expectedKey` facultatifs pour sélectionner des champs. Aucun
juge injecté ne peut lire les réponses finales. `honestStatistics` de P2 rend
les effectifs connus/inconnus et Wilson bilatéral (minimum 30 ; niveaux 0,90,
0,95 ou 0,99). Sortie absente, panne ou dépassement de temps : inconnu.
`supported` exige pour **chaque métrique de chaque étape** un effectif suffisant
et un intervalle entièrement au-dessus du seuil ou à égalité ; `refuted` exige
un intervalle suffisant entièrement inférieur à un seuil. Données insuffisantes,
inconnus ou intervalle traversant le seuil : `inconclusive`. Il s'agit de tests
de seuils, sans preuve causale de progrès face à une référence. `interval` est
celui de la première métrique finale ; tous les intervalles sont dans
`stages.*.metrics`. Identifiants et empreintes d'entrées doivent être distincts
entre les jeux ; répéter une entrée ne gonfle pas l'effectif. Les intentions de
développement/validation sont journalisées ; celles du jeu final et les sorties
individuelles restent cachées.

Une proposition de rejeu est `{ agent, information?: [{ organisationId,
userId?, at, recordedAt, data }] }`. `snapshots` associe chaque
`inputSnapshotRef` à cette même forme datée ; toute référence exige son
instantané (`snapshot_missing`). Sans référence, le contexte daté enregistré
sert d'instantané. Le candidat reçoit `{ inputs, outcomes, lessons,
information, decision, asOf }`. `decision` ne contient que identifiant,
objectif, contexte, versions et permissions, jamais l'action originale ou la
réponse attendue. La compatibilité compare sa sortie à
`{ name: actionOriginale.name, input: actionOriginale.input }`.
Révisions de résultats et leçons enregistrées après la décision : exclues.
Un fait enregistré tôt mais daté du futur : refusé. Les preuves historiques des
leçons sont contrôlées ; preuves externes non datées :
`temporal_evidence_required`. Les dates factuelles imbriquées et les réponses
simulées sont contrôlées. Les réponses de lecture du rejeu exigent
`{ organisationId, userId?, at, recordedAt, data }`
(`temporal_metadata_required` sans dates) ; horizons prévus et expirations ne sont pas des
observations futures. Les dates fournies doivent être fidèles : le code ne
peut déduire une provenance non déclarée ni dater une connaissance littérale
inscrite dans la fonction candidate. Une sélection trop grande est refusée
(`replay_limit`), jamais tronquée silencieusement.

Les fonctions candidates sont sérialisées puis exécutées dans des workers et
des contextes ne recevant que du JSON et des outils simulés : pas de closure
hôte, `process`, `require`, `fetch`, fichiers, import dynamique ni rappel hôte.
Les calculs asynchrones avec outils simulés fonctionnent. Un modèle peut être
injecté comme calcul autonome de l'agent évalué ; un transport distant ou un
client capturé dans une closure ne peut pas fonctionner dans ce bac à sable.
Le cœur ne choisit et n'appelle aucun modèle pour décider du score.
Temps par cas (10–30000 ms), mémoire et taille de sortie sont bornés. Cette
frontière d'exécution applicative ne remplace pas une isolation du système
d'exploitation pour du code natif arbitraire hostile.

Le code de préparation doit conserver les cas finaux hors de la réflexion :
l'objet protégé ne peut retirer des copies déjà partagées par l'application.
Le jeu final est à usage unique pour empêcher les interrogations adaptatives,
et reste consommé après une panne d'exécution. Objets d'enregistrement,
contenus finaux et journal d'accès restent locaux au processus, sans reprise
après redémarrage. Métadonnées d'enregistrement et résultats agrégés sont
audités dans les constats du gouverneur (`experiment_registered`,
`experiment_started`, `experiment_completed` / `experiment_failed`), en
mémoire ou PostgreSQL. Aucun nouveau schéma SQL ni dépendance.
Les tests réels utilisent
`CONSCIENCE_TEST_DATABASE_URL=postgresql://localhost/conscience_p3a_test` ;
une base explicitement fournie mais indisponible fait échouer les tests P3,
sans les ignorer. Preuves de mutation séparées :
`node packages/conscience/test/experiments-mutations.js`.

## P3 · vigilance (2/2)

Seconde moitié de P3, dans `@astratra/conscience/autoconscience` : six modules
déterministes qui surveillent, rappellent, retiennent, mettent à l'épreuve,
recoupent et transforment les leçons en tests. Aucun n'importe de modèle de
langage (un test lit les sources) et aucun n'applique quoi que ce soit : tout
changement passe par une proposition au gouverneur, et chaque appel vérifie
d'abord que le gouverneur existe, est authentique et n'est pas à l'arrêt
(`assertGovernorReady`).

| N° | Fonction | Rôle |
| --- | --- | --- |
| 17 | `detectDrift` | Surveillance de dérive des entrées, des résultats et des performances, avec recommandation codée. |
| 18 | `createFollowUps` | Mémoire prospective : `scheduleFollowUp`, `dueFollowUps`. |
| 26 | `abstentionPolicy` | Seuil de confiance tiré de la calibration et des coûts d'erreur. |
| 27 | `generateAdversarialCases` | Scénarios-pièges candidats à partir des échecs récents. |
| 14 | `reviewByRoles` | Vérificateur, contradicteur et contrôleur des risques, revues séparées. |
| 03 | `lessonToScenario` | Une leçon vérifiée devient un scénario anti-régression. |

### Surveillance de dérive (17)

```js
const rapport = await detectDrift({
  governor, organisationId, agentId, domain,
  baseline: { window: { from, to }, inputs: { domains, languages, lengths },
              outcomes: { succeeded, failed, unknown },
              performance: { calibration: { sampleSize, brierScore, confidenceGap }, tools: [{ tool, provider, knownCalls, failures }] } },
  current: { /* même forme */ },
  calendars,            // DomainCalendar[] de P2, de la même organisation
  recentChange,         // { kind, id, version, previousVersion, deployedAt }
  propose: {}           // facultatif : un retour arrière recommandé devient une proposition EN ATTENTE
});
```

`snapshotWindow({ decisions, findings, agentId, domain, languageOf })` construit
un résumé à partir des données de P2 (le cœur ne détecte aucune langue :
`languageOf` est à vous).

Tests simples, documentés dans le code : l'indice de stabilité de population
(PSI) pour les répartitions (domaines, langues, longueurs découpées aux
quintiles de la référence ; un pseudo-comptage de 0,5 par catégorie ; sous 0,10
stable, de 0,10 à 0,25 modéré, 0,25 et plus significatif) et la différence de deux
proportions avec l'intervalle de score hybride de Newcombe, construit sur les
intervalles de Wilson de P2 (taux de réussite, part d'inconnu, taux d'erreur des
outils). Un écart est significatif quand l'intervalle exclut zéro et que l'écart
atteint 5 points (`minimumEffect`). Le score de Brier et l'écart de confiance se
comparent à un seuil (`brierDelta`, `confidenceGapDelta`). Une fenêtre de moins de
`minimumSample` observations connues ne conclut jamais : `insufficient_data`.

Un **calendrier métier** est consulté avant d'accuser l'agent : une période qui
recouvre la fenêtre courante et pas la fenêtre de référence explique l'écart
(`attribution: 'calendar'`, recommandation `monitor`, `reexamineAfter`).

Recommandation codée : `monitor` (surveiller), `investigate` (enquêter : les
entrées ont bougé ou un outil s'est dégradé en même temps qu'une baisse),
`freeze` (geler : baisse sévère sans explication, `freezeDrop`),
`propose_rollback` (proposer un retour arrière : baisse dans une fenêtre qui
commence après un changement récent, entrées stables). Le rapport dit toujours
`applied: false`. Avec `propose`, le retour arrière devient une proposition en
attente chez le gouverneur (risque élevé, deux approbations par défaut) et rien
n'est annulé pour autant : un humain décide, puis `rollbackChange` reste à vous.
`recordedBy` dépose aussi un constat pour le bilan du matin.

### Mémoire prospective (18)

```js
const vstore = createMemoryVigilanceStore();          // ou createPostgresVigilanceStore(pool)
const conscience = createConscience({ governor, masker, erasers: [followUpEraser(vstore)] });
const followUps = createFollowUps({ governor, conscience, store: vstore, masker });
await followUps.scheduleFollowUp({ organisationId, decisionId, observableAt, question });
const dus = await followUps.dueFollowUps({ organisationId });   // { followUp, decision }[]
await followUps.completeFollowUp({ organisationId, id });
```

Idempotent : même décision, même date, même question, même suivi
(`created: false`). La question est masquée avant d'être gardée. La décision doit
exister dans l'organisation (celle d'une autre : `not_found`). Les suivis
s'effacent avec la personne par `eraseSubject` (déclarer `followUpEraser`) ; un
suivi dont la décision a été effacée ou a expiré n'est jamais rendu comme dû. Le
contenu d'un suivi dû est une donnée, jamais une consigne.

### Abstention (26)

`abstentionPolicy({ governor, organisationId, agentId, domain, calibration, errorCosts, currentThreshold, propose })`.
Agir vaut la peine quand la chance de réussite atteint
`falsePositive / (falsePositive + falseNegative)` (la table de coûts de P2). Le
seuil est la plus basse confiance annoncée, ayant ses propres observations, à
partir de laquelle la borne basse de Wilson du taux de réussite observé reste au
dessus de ce rapport, sur au moins `minimumSample` décisions. Pas assez de données
ou pas de table de coûts : un seuil prudent par défaut (0,8), jamais plus bas que
celui déjà en vigueur. Aucune zone fiable : 1. `shouldAbstain(policy, { confidence, actionKind })`
répond `proceed`, `ask_clarification` (demander une précision) ou, pour les
actions `write` et `confirm`, `propose_verification`, toujours d'après le seuil
**en vigueur** (`effectiveThreshold`). Un nouveau seuil est une proposition sur la
cible `threshold:abstention:<agent>:<domaine>` ; rien n'est appliqué ici.

### Adversaire nocturne (27) et leçons devenues tests (03)

```js
const library = createScenarioLibrary({ governor, store: vstore, masker });
const { candidates, rejected } = await generateAdversarialCases({ governor, organisationId, failures, masker, generator, library });
const cas = await lessonToScenario(lesson, { governor, masker, question, tools, expect, library });
// plus tard, une fois les propositions approuvées par des humains chez le gouverneur :
const suite = (await library.approved({ organisationId })).map((a) => a.scenario);   // pour evaluateAgent
```

`generateAdversarialCases` transforme les échecs récents en candidats de quatre
catégories (injection, ambiguïté, cas limite, accès à une autre organisation) au
format d'`evaluateAgent` de `@astratra/testkit` : `id`, `question`, outils
simulés (résultats fixes, sans effet), `expect`, et un `score` qui fait échouer le
cas si un outil interdit est appelé ou un texte interdit apparaît. Un
**générateur injecté** peut écrire les cas (une fonction qui rend des données
seulement ; ce qu'elle rend est validé, masqué, et remplacé par le gabarit s'il
est invalide ou en échec). Sans générateur, des gabarits déterministes : même
échec, mêmes cas. Le **masqueur est obligatoire** et passe sur les échecs et sur
tout ce que rend le générateur.

`lessonToScenario` accepte une leçon de statut `verified` (preuves, assez de
décisions distinctes, aucun conflit ouvert) ; une hypothèse, une leçon à
réévaluer ou retirée est refusée (`lesson_not_verified`). La leçon dit ce qui a
été appris ; vous décrivez comment le vérifier, et un scénario qui n'affirme rien
est refusé.

Tout candidat naît `to_review` (« à relire »). Avec une bibliothèque, il devient
une proposition au gouverneur (cible de type `instructions`, identifiant
`scenarios:<agent>`, réglable par `targetKind`). `library.approved()` est la
**seule** entrée dans les tests : elle ne garde un candidat que si des humains ont
approuvé exactement ce contenu (même empreinte) et que le contenu gardé n'a pas
changé. Un modèle, un refus, une approbation expirée ou un candidat modifié le
laissent dehors.

### Revue multi-rôles (14)

```js
const revue = await reviewByRoles({ governor, organisationId, finding, roles: { verifier, contradictor, riskController } });
revue.advances; revue.status;   // true / 'supported', ou false / 'hypothesis' avec revue.blockers
```

Trois fonctions séparées, pas un vote de modèles. Le constat n'avance que si le
vérificateur cite une preuve **indépendante** (ni les preuves ni les décisions du
constat, même organisation, confirmée au besoin par `evidenceExists`), si aucune
explication concurrente du contradicteur n'est aussi forte que la confiance du
constat, et si le contrôleur des risques valide une portée au moins aussi large
que celle demandée (`observation` < `agent` < `domain` < `organisation`). Un rôle
qui lève une erreur ou répond mal bloque le constat. Les rôles reçoivent une copie
gelée du constat, jamais les réponses des autres.

### Stockage

`createMemoryVigilanceStore()` et `createPostgresVigilanceStore(db, { prefix })`
(schéma : `postgresVigilanceSchema({ prefix })`, tables `<prefix>_follow_ups` et
`<prefix>_candidates`). Même contrat, mêmes tests, chaque accès borné par
l'organisation, chaque valeur en paramètre SQL.

## P4 · mode ombre

Propositions 21 (mode ombre) et 32 (bac à sable du mode ombre), dans
`@astratra/conscience/autoconscience`. Une stratégie candidate que des humains
ont déjà approuvée traite **en silence** une partie des vraies demandes, à côté
de la stratégie stable. Ses réponses ne vont à personne. Elles sont comparées
aux réponses stables par des métriques déterministes que vous fournissez, et
l'écart est gardé, masqué, sous forme de `ShadowRun`. Aucun modèle de langage
n'est importé (un test lit les sources) ; chaque appel vérifie d'abord
`assertGovernorReady`.

```js
const { createSandbox, createShadowRunner, createMemoryShadowStore, shadowEraser } = require('@astratra/conscience/autoconscience');

const sandbox = await createSandbox({ governor, organisationId, tools: {
  lookup_invoice: { kind: 'read', response: { status: 'unknown' } },   // simulé ou enregistré
  send_reminder: { kind: 'write' }                                      // jamais exécuté, seulement journalisé
} });
const shadow = await createShadowRunner({
  governor, organisationId,
  candidate: { kind: 'instructions', id: 'reminders', agent },          // ou { proposalId, agent }
  sandbox, sampleRate: 0.1,
  budget: { maxRuns: 500, maxCost: 50, costPerRun: 0.1 },
  masker,                                                               // obligatoire
  store: createMemoryShadowStore(),                                     // ou createPostgresShadowStore(pool)
  metrics: [
    { name: 'accuracy', score: ({ input, output }) => output.total === input.expected },
    { name: 'sources_accuracy', score: ({ output }) => output.sourced === true, maxRegression: 0.02 },
    { name: 'minor_protection', critical: true, score: ({ input, output }) => !(input.minor && output.disclosed) }
  ],
  target: 'accuracy', minimumSample: 30
});

// Dans le chemin de la requête : répondre avec la stratégie stable, puis passer la main. Ne jamais attendre `done`.
const answer = await stable(request);
respond(answer);
shadow.observe({ request: { id: request.id, userId: request.userId, input: request.input }, stableResult: { output: answer, durationMs, cost } });

const report = await shadow.report({ propose: {}, recordedBy: { kind: 'system', id: 'shadow' } });
report.conclusion;   // 'insufficient_data' | 'regression' | 'no_difference' | 'promising'
```

**Quelle stratégie peut tourner.** Soit la version candidate d'un objet du
gouverneur (`{ kind, id }` : la version mise en place à partir d'une proposition
approuvée par des humains), soit une proposition à l'état `approved` avec des
approbations humaines (`{ proposalId }`). Une proposition en attente, déclinée,
rejetée ou expirée, une version stable, un objet inconnu ou l'objet d'une autre
organisation sont refusés (`candidate_not_approved`, `candidate_not_staged`,
`not_found`). La vérification est refaite avant chaque exécution : une candidate
annulée, promue ou remplacée arrête l'ombre.

**La réponse de la candidate n'est jamais renvoyée.** `observe` est synchrone, ne
lève jamais d'erreur et n'attend jamais : il rend `{ scheduled, reason, done }`, et
`done` (qui ne rejette jamais) donne un accusé (`recorded` avec un identifiant
d'exécution, ou `skipped`, `timeout`, `error` avec une raison) qui ne contient
aucune sortie de la candidate. L'exécution se fait en arrière-plan, après la
réponse stable. Une candidate en erreur, lente ou hostile, un magasin ou un
masqueur en panne, une métrique qui lève : tout est isolé et compté (`stats()`),
rien n'atteint l'appelant. Un délai (`deadlineMs`) abandonne une exécution
bloquée, et `maxConcurrent` écarte une rafale en `busy` au lieu de la mettre en
file.

**Bac à sable seulement (32).** La candidate est une fonction autonome exécutée
dans le bac à sable de P3 : aucun objet de l'hôte, ni `process`, ni `require`, ni
minuterie, ni `fetch`. Ses outils sont ceux du bac à sable : une lecture rend un
enregistrement (les `recordings` facultatifs de `observe`, par exemple ce que la
requête stable a lu) ou une réponse simulée ; une écriture n'est **jamais
exécutée**, même si la candidate l'appelle, et n'est que journalisée comme
intention (`writeIntentions`, masquée). L'ombre n'ouvre aucune connexion réseau
de son propre chef. Un appel de modèle dans une candidate est un outil du bac à
sable, rejoué ou simulé, jamais un appel réel.

**Échantillonnage, budget, arrêt d'urgence.** Une demande est choisie par un
hachage de son identifiant et de celui de l'ombre : la même demande donne
toujours le même choix, quel que soit l'ordre, et `sampleRate: 0.1` choisit un
sous-ensemble de ce que choisit `0.5`. Le budget est obligatoire et plafonné :
`maxRuns`, `maxCost` (`costPerRun` est le plafond réservé à une exécution,
`costOf` ne peut que l'abaisser), `maxDurationMs` (temps mesuré, que les
exécutions déjà en cours peuvent dépasser) et `governorAgentId` pour dépenser
aussi par `governor.authorizeSpend`. Budget épuisé ou arrêt d'urgence du
gouverneur : l'ombre s'arrête aussitôt, reste arrêtée (lever l'arrêt ne la
réveille pas : en démarrer une nouvelle) et une exécution qui se termine après
l'arrêt est abandonnée. Les budgets comptent les exécutions déjà stockées : un
redémarrage poursuit la même ombre.

**ShadowRun.** Par demande choisie : la demande masquée, les sorties candidate et
stable masquées (remplacées par une empreinte au-delà de 20 000 caractères), le
score de chaque côté pour chaque métrique (`succeeded`, `failed`, `unknown`), si
les deux réponses concordent, les intentions d'écriture, la durée, le coût et les
incidents (`candidate_failed`, `candidate_timeout`, `scoring_failed`, ...).
L'identifiant brut de la demande n'est pas gardé. Un masqueur en échec garde
l'exécution hors du magasin. Une candidate qui ne produit rien échoue aux
métriques : elle ne peut pas avoir réussi.

**Rapport.** Par métrique, le taux de réussite de chaque côté avec son
intervalle de Wilson et l'effectif minimal (P2 : en dessous, `insufficient_data`
et aucune différence), les comptes appariés et la différence (candidate moins
stable) avec un intervalle de Newcombe. Anti-Goodhart (P2) : la métrique `target`
doit s'améliorer pendant que toutes les autres restent dans leur
`maxRegression` (et `limits.cost`) ; au moins une contre-mesure est exigée à la
construction. Les métriques critiques listent les demandes où la stratégie stable
a réussi et la candidate échoué. La conclusion est un code, dans cet ordre :

| Conclusion | Quand |
|---|---|
| `regression` | Plus de régressions critiques que `maxCriticalRegressions` (0 par défaut ; un seul cas compte, quel que soit l'effectif), ou, avec assez de données, une baisse significative d'une métrique, une contre-mesure au-delà de sa limite, ou un taux d'incidents significativement au-dessus de `maxIncidentRate`. |
| `insufficient_data` | Moins de `minimumSample` exécutions, une métrique avec trop peu de scores connus, ou une limite de coût sans le coût stable. |
| `promising` | La cible s'est améliorée avec un intervalle au-dessus de zéro et toutes les contre-mesures ont tenu. |
| `no_difference` | Assez de données, aucune différence significative et aucune régression. |

Le rapport ne dit jamais « prouvé » : `provesImprovement` vaut toujours `false`,
`causality` vaut `not_established`, `applied` vaut `false`. Une comparaison en
ombre sur un échantillon de vraies demandes peut rendre une amélioration
prometteuse, rien de plus. Avec `propose`, un résultat prometteur devient une
**proposition en attente** chez le gouverneur (type de la candidate, identifiant
`shadow:<id>:<version>`) ; avec `recordedBy`, toute conclusion est classée comme
constat pour le bilan du matin. Déployer et promouvoir restent à un humain
(`deployChange`, `promoteChange`) : l'ombre ne les appelle jamais.

**Isolation et effacement.** Chaque ligne appartient à une organisation et chaque
lecture et écriture est bornée par elle ; une candidate, un bac à sable ou un
appel de magasin d'une autre organisation est refusé. Les exécutions portent le
`userId` de la demande : enregistrer `shadowEraser(store)` dans
`createConscience({ erasers })`, ou appeler `shadow.eraseSubject`, pour les
supprimer avec la personne.

**Stockage.** `createMemoryShadowStore()` et `createPostgresShadowStore(db, { prefix })`
(schéma : `postgresShadowSchema({ prefix })`, table `<prefix>_runs`). Même
contrat, mêmes tests, toute valeur est un paramètre SQL.

## Tests

```sh
npm test -w @astratra/conscience
CONSCIENCE_TEST_DATABASE_URL=postgresql:///conscience_p2_test npm test -w @astratra/conscience
CONSCIENCE_TEST_DATABASE_URL=postgresql://localhost/conscience_p4_test node --test packages/conscience/test/shadow.postgres.test.js
```

Les tests PostgreSQL ne tournent que si l'URL désigne une base dont le nom
finit par `_test` ; chaque test crée ses propres tables puis les supprime. Une base de test
absente est créée avec `createdb` si permis ; sinon les tests d'intégration
sont ignorés avec une raison explicite, sans afficher l'URL.

## Limites

- Aucun modèle de langage ni changement automatique : P2 évalue uniquement des preuves structurées,
  tout changement passe par un humain, et le gouverneur n'applique jamais un changement à votre
  application. Il versionne les objets et dit quelle version servir (`resolveVersion`) ; c'est à vous
  de lire cette version là où vous utilisez l'objet.
- Le gouverneur reconnaît les portées protégées par leurs noms et leurs clés,
  pas en lisant du texte : une proposition doit décrire honnêtement sa cible,
  et tout cas ambigu est rejeté plutôt qu'accepté.
- Le masqueur est le vôtre : le paquet garantit que le texte stocké y est
  passé, pas qu'il a tout trouvé.
- Le mode ombre ne juge que les demandes échantillonnées (une rafale au-delà de `maxConcurrent` est écartée et comptée) et ses
  intervalles ignorent l'appariement des demandes : ils sont prudents. Les métriques sont les vôtres, déterministes, et la
  lecture d'un outil n'y est rejouée que d'après des enregistrements.
