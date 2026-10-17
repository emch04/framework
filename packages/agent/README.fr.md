# @astratra/agent

[English](README.md) | [Français](README.fr.md)

Exécution de tâches durables au-dessus de `runToolLoop` de `@astratra/ai` :
budgets (temps, tours, jetons, coût), annulation, plans, vérification de fin,
résumés de contexte, reprise après arrêt, confirmation avant les actions
sensibles, et retours des utilisateurs (pouce haut / bas) dont l'agent tient
compte. Modèles, outils, vérifications et stockage sont injectés. Node ≥ 20,
CommonJS, MIT. Aucun fournisseur d'IA ni pilote de base de données inclus.

```sh
npm install @astratra/agent
```

```js
const { createAgent, createMemoryTaskStore } = require('@astratra/agent');

const agent = createAgent({
  guards: false, // ou recommendedGuards({ models }) de '@astratra/ai/guards' : voir « Gardes »
  store: createMemoryTaskStore(),
  turn: async ({ system, messages, tools, signal, phase }) => ({ text: 'Le résultat est 3.', usage: { inputTokens: 40, outputTokens: 8 } }),
  budget: { maxMs: 600000, maxTurns: 200, maxTokens: 100000, maxCost: 2 },
  verify: ({ text }) => ({ complete: text.includes('3'), feedback: 'Calculez le résultat.' })
});
const task = await agent.run({ question: 'Calcule 1 + 2.' });
```

La référence complète de l'exécution (budgets, plans, vérifications, baux,
confirmations, événements) est dans le [README anglais](README.md). Cette page
détaille les retours.

## Retours des utilisateurs

`@astratra/agent/feedback` (aussi réexporté par l'entrée principale) recueille
un pouce haut ou bas sur une exécution et permet à l'agent d'en tenir compte.
Stockage, identité, masquage et lecture des exécutions sont injectés.

```js
const { createAgent, createFeedback, createFeedbackRouter,
  createPostgresFeedbackStore, postgresFeedbackSchema } = require('@astratra/agent');

await db.query(postgresFeedbackSchema());
const feedback = createFeedback({
  store: createPostgresFeedbackStore(db),     // ou createMemoryFeedbackStore()
  mask: (texte) => masqueur.mask(texte),      // noms -> jetons
  readRun: async ({ runId, tenantId }) => chargerExecution(runId) // { question, mode, tools, answer }
});
const agent = createAgent({ turn, feedback });
const task = await agent.run({ question, userId, tenantId }); // task.id = identifiant d'exécution
app.use('/api', createFeedbackRouter({
  feedback,
  identify: (req) => ({ userId: req.user.id, tenantId: req.user.orgId }),
  resolveRun: async (req, runId, qui) => executionDe(runId, qui) // faux => 404
}));
```

- **Modèle** : un seul retour par personne et par exécution (et par
  organisation). Donner à nouveau le remplace ; `update` en modifie des champs ;
  `remove` le retire. La raison n'existe que pour `down` et vient d'une liste
  fixe (`inaccurate`, `incomplete`, `off_topic`, `wrong_source`, `too_long`,
  `unsafe`, `other`), extensible par `reasons`. Le commentaire est borné
  (`maxComment`, 500 par défaut) et refusé au-delà, jamais tronqué en silence.
- **Magasins** : mémoire et PostgreSQL (SQL paramétré uniquement, schéma
  exporté, clé unique organisation + personne + exécution).
- **Routeur Express** (express est une dépendance de pair facultative) :
  `POST`, `PATCH`, `GET`, `DELETE` sur `/runs/:runId/feedback`. L'application
  fournit l'identité (`identify`, 401 sinon) et vérifie que l'exécution
  appartient à la personne (`resolveRun`) : une exécution étrangère répond 404,
  comme une inconnue. Champs inconnus refusés, corps limité à 8 Kio.
- **L'agent en tient compte** : `createAgent({ feedback })` ajoute au prompt
  système, en début de tâche, le résumé de ce que la personne n'a pas aimé
  récemment (`feedbackDigest`), conservé dans la tâche pour une reprise
  identique. Il est borné (800 caractères par défaut, 4000 au plus côté agent),
  présenté comme une préférence et non une consigne, et ses commentaires sont
  masqués, nettoyés et coupés. Une panne du résumé ne fait jamais échouer la
  tâche. L'identifiant d'exécution est `task.id`, repris par les événements
  `run` et `final` (`runId`).
- **Des 👎 aux tests** : `exportScenarioCandidates({ rating: 'down', since })`
  produit des scénarios candidats anonymes (masqueur obligatoire, aucun
  identifiant de personne ni d'organisation) ; `toAgentScenarios` les convertit
  pour `evaluateAgent` de `@astratra/testkit` après relecture.
- **Statistiques** : `stats({ groupBy: 'agent' | 'mode' | 'reason' | 'day', since, until })`
  donne totaux, taux 👍/👎 et groupes.

Les composants d'interface sont `FeedbackBar` dans `@astratra/native-ui`
(React Native) et `@astratra/saas-kit-ui` (web).

## Gardes (actives par défaut)

`createAgent({ guards })` accepte les gardes de `@astratra/ai/guards`
(`recommendedGuards` ou `createGuards`, fondées sur le client
`@astratra/models` injecté) : tout agent créé avec le paquet est protégé.

```js
const { recommendedGuards } = require('@astratra/ai/guards');
const guards = recommendedGuards({ models });          // readOnly: true pour un agent qui n'agit pas
const agent = createAgent({ guards, turn, tools, onEvent });
```

| Moment | Garde |
| --- | --- |
| début d'une tâche | `newRun` : mode `action` si un outil est de genre `write` ou `confirm`, sinon `read` (la politique de panne suit le mode) |
| la question et les messages précédents, avant tout modèle | `input` : noms et données personnelles masqués. Une saisie bloquée fait échouer la tâche (`error.code === 'GUARD_BLOCKED'`) |
| chaque résultat d'outil | `toolResult` : masqué ; pour un outil marqué `external: true` (web, e-mail, fichiers), contrôlé aussi contre l'injection et encadré comme donnée non fiable. Un résultat `{ untrusted: true, content }` est traité comme externe |
| avant un outil `write` ou `confirm` | `beforeAction` |
| la réponse finale | `output` : démasquée, puis ancrage dans les sources lues, fuite de données personnelles, modération |

**Action refusée.** Une injection suspectée, un outil `write` ne s'exécute pas :
la tâche passe en `waiting_confirmation` avec
`confirmation: { key, call, guard: { reason: 'confirmation_required' } }`. On
reprend avec `{ confirmation: { key, approved: true } }` (depuis votre
interface, jamais depuis le modèle) pour exécuter cet appel, ou `approved: false`
pour enregistrer un refus que le modèle lit. Un refus pour toute autre raison est
rendu au modèle comme une erreur d'outil (`Blocked by a guard: ...`), sans
exécution. Les outils `confirm` attendent déjà une personne ; leur confirmation
porte `guard: { requiresConfirmation: true }` quand une injection est suspectée,
et `beforeAction` est interrogée à nouveau, avec la confirmation, avant `perform`.

**Réponse.** Une réponse bloquée n'est jamais livrée : la tâche est `failed`,
`stopReason: 'guard'`, sans `task.text`. Une réponse signalée (par exemple des
affirmations que les sources ne soutiennent pas) est livrée, et `task.guard`
garde `{ decision, reasons, degraded, groundingScore, unsupportedClaims }`
(nombres et codes, aucun texte). `verify` reçoit la réponse démasquée et contrôlée.

**Événements.** Les décisions arrivent dans `onEvent` sous la forme
`{ type: 'guard', taskId, guard, decision, reasons, degraded, metrics, runId, mode, at }`
(l'identifiant d'exécution est celui de la tâche). Jamais de texte.

**État et reprise.** L'état des gardes est gardé dans la tâche (`task.guards`)
après la saisie et après chaque résultat d'outil : table de masquage, drapeau de
confirmation, empreintes des données personnelles données, sources externes lues
(masquées). Une tâche reprise, même dans un autre processus avec de nouvelles
gardes, démasque avec les mêmes jetons et exige toujours la confirmation. Les
messages de la tâche sont stockés masqués et `task.maskedQuestion` est ce que le
modèle lit. La table de masquage contient les vraies valeurs (c'est ainsi que la
réponse est démasquée) et `task.question` reste telle quelle : protégez le
magasin de tâches comme les données qu'il contient. Les outils reçoivent
`context.unmask(texte)` pour retrouver la vraie valeur d'un jeton écrit par le
modèle ; les arguments sont sinon transmis comme le modèle les a écrits.

**Par défaut.** `guards` est un choix à faire, pas une option à oublier :

- `NODE_ENV=production` sans `guards` : `createAgent` lève
  `guards required in production: pass guards or guards:false`.
- ailleurs, sans `guards` : rien n'est gardé et un événement `warning`
  (`code: 'guards_missing'`) est envoyé par agent.
- `guards: false` : choix explicite et silencieux.

Pour les tests : `createMockGuards` et `createFakeModels` de
`@astratra/ai/guards/testing`.

### Montrer la réponse pendant qu'elle s'écrit

Avec des gardes, `turn` reçoit `unmask(texte)` : il rend les vrais mots d'un texte du modèle (masqué). Avec `onText`
de `@astratra/ai` (1.10.0), on montre ainsi la réponse en flux, sans ses repères (`#PERSON_0001`). La réponse finale
passe toujours par la garde de sortie (fuites, modération) ; ce qui part au modèle reste masqué.

## Ordonnanceur (tâches programmées)

Des tâches qui tournent à heure fixe chaque jour, un jour de la semaine, ou à intervalle, dans un fuseau horaire IANA.
Rien ne démarre au chargement du module : on appelle `start()`.

```js
const { createScheduler } = require('@astratra/agent');

const scheduler = createScheduler({
  timeZone: 'Europe/Paris',
  maxLateMs: 6 * 3600 * 1000,                  // un passage manqué de plus de 6 h est sauté, pas lancé
  shouldStop: () => reglages.arretUrgence,      // consulté avant ET pendant chaque passage
  tasks: [
    { id: 'rapport-du-jour', schedule: { type: 'daily', at: '07:00' }, run: ({ signal }) => produireRapport(signal) },
    { id: 'resume-hebdo', schedule: { type: 'weekly', day: 'monday', at: '07:30' }, run: envoyerResume },
    { id: 'nettoyage', schedule: { type: 'interval', everyMs: 15 * 60 * 1000 }, run: nettoyer }
  ]
});
scheduler.start();                              // passage périodique (tous les tickMs, 30 s par défaut)
await scheduler.run('nettoyage');               // lancement manuel ; ne déplace pas le prochain passage prévu
await scheduler.state();                        // lastRunAt, nextRunAt, status, lastResult, lastError, skipReason
scheduler.abortAll();                           // coupe tous les passages en cours (leur signal s'annule)
scheduler.stop();                               // arrête le passage périodique
```

- **Programmations** : `{ type: 'daily', at: 'HH:MM' }`, `{ type: 'weekly', day | days, at }` (1 = lundi … 7 =
  dimanche, ou `'monday'`), `{ type: 'interval', everyMs }`. `timeZone` est global ou propre à la tâche. Les
  changements d'heure sont gérés : 07:00 reste 07:00 à l'horloge murale. Une heure qui n'existe pas (02:30 au passage à
  l'heure d'été) part juste après le trou ; une heure qui existe deux fois part une seule fois, à la première
  occurrence. `nextRun(schedule, apresMs, timeZone)` est exportée.
- **Intervalle aligné (1.3.0)** : `{ type: 'interval', everyMs: 3600000, align: true }` part sur les marques rondes de
  la journée locale (07:00, 08:00… ; toutes les 15 min : :00, :15, :30, :45), comptées depuis minuit local, quelle que
  soit l'heure de démarrage. `everyMs` doit être un nombre entier de secondes, d'un jour au plus.
- **Réglages à chaud (1.3.0)** : `enabled` (booléen ou `async () => booléen`) et `schedule` (objet ou
  `async () => programmation`) d'une tâche sont relus à chaque passage : un tableau de bord peut couper une tâche ou la
  déplacer sans redémarrage. Une tâche coupée a `nextRunAt: null` ; une programmation changée est replanifiée au passage
  suivant (résultat `'rescheduled'`, la tâche ne part pas dans ce passage). Une fonction qui échoue ou rend une mauvaise valeur est signalée à `onError` ; la tâche est
  laissée de côté pour ce passage (son plan est gardé) et les autres continuent. `state()` montre `enabled` et `schedule` en vigueur.
- **Jamais deux fois en même temps** : chaque passage prend un `lock` (`acquire(cle)` → `{ release() }` ou `null`). Par
  défaut un verrou dans le processus ; avec plusieurs processus, `createPostgresLock(pool)` (`pg_try_advisory_lock`,
  tenu sur une connexion du pool jusqu'à `release()`, libéré si le processus meurt). L'état est relu sous le verrou :
  un processus qui perd la course ne relance pas une tâche qu'un autre vient de finir. Partagez le `store` (plus bas)
  entre les processus.
- **Passages manqués** : un passage échu depuis plus de `maxLateMs` (par tâche ou global, 1 h par défaut) est sauté
  (`skipReason: 'late'`) et le suivant est programmé. En deçà du délai, il part quand même.
- **Arrêt global** : `shouldStop()` est lu avant chaque passage (un passage programmé est sauté avec `'stopped'`, un
  lancement manuel lève `SchedulerError('stopped')`) puis toutes les `stopCheckMs` (1 s) pendant l'exécution ; s'il
  rend vrai, le `signal` de la tâche s'annule. Un `shouldStop` qui échoue vaut arrêt. Un passage coupé ainsi n'est pas
  compté comme fait.
- **État** : `status` vaut `scheduled`, `running` (indicatif : le verrou fait foi), `ok`, `error` ou `skipped`.
  `lastResult` (JSON) est repassé au passage suivant en `previous`, pour les tâches qui évitent de se répéter.
- **Stockage de l'état** : mémoire par défaut ; `createPostgresScheduleStore(db)` le garde dans une table
  (`postgresScheduleSchema()` la crée).
- **Tests** : injectez `now` (fonction rendant des ms ou une `Date`) et appelez `tick()` vous-même.
- `onEvent` (`start`, `done`, `error`, `skipped`) et `onError` observent l'ordonnanceur sans jamais le casser.

## File d'actions en attente d'approbation

Des actions qu'une personne doit approuver, **détachées de toute exécution en cours** : on propose maintenant, on décide
des heures ou des jours plus tard. Le paquet n'authentifie personne : vous contrôlez l'identité et le rôle (dans votre
route, ou dans `authorize`) et passez le décideur. L'action est exécutée par **votre** exécuteur.

```js
const { createApprovalQueue, ApprovalRefused } = require('@astratra/agent');

const queue = createApprovalQueue({
  executors: {
    publier: async ({ input, idempotencyKey, signal }) => {
      if (!input.titre) throw new ApprovalRefused('incomplet', { manquants: ['titre'] });  // rien n'a été fait
      return await publierArticle(input, { idempotencyKey, signal });                      // le résultat est gardé
    }
  },
  authorize: ({ decider }) => decider.role === 'proprietaire',   // votre règle ; false ou une exception = interdit
  beforeExecute: () => { if (reglages.arretUrgence) throw new Error('arrêt'); },         // dernier contrôle, facultatif
  onEvent: ({ type, action }) => journal(type, action.id)        // proposed, approved, rejected, refused, failed, expired
});

const action = await queue.propose({ type: 'publier', input: { titre: 'Bonjour' }, requestedBy: 'assistant', ttlMs: 3 * 24 * 3600 * 1000 });
await queue.list({ status: 'pending' });
await queue.approve(action.id, { decider: { id: 'u-1', role: 'proprietaire' } });   // → { action, result }
await queue.approve(action.id, { decider, input: { titre: 'Bonjour à tous' } });     // l'action telle que corrigée
await queue.reject(action.id, { decider: { id: 'u-1', role: 'proprietaire' }, reason: 'pas maintenant' });
await queue.expire();                                                                // fait aussi par list/approve/reject
```

- **Une seule exécution** : `approve` *réserve* d'abord l'action (`pending` → `approved`) en une étape atomique du
  stockage, puis lance l'exécuteur. Deux approbations simultanées : l'une s'exécute, l'autre reçoit
  `ApprovalError('already_decided')`. Avec PostgreSQL, la réservation est un seul `UPDATE` conditionnel. L'exécuteur
  reçoit `idempotencyKey` (l'identifiant de l'action) : utilisez-la côté système externe, car une file ne peut pas
  défaire un effet survenu avant un plantage. Une action restée `approved` avec `executedAt: null` après un plantage se
  retrouve par `list({ status: 'approved' })`.
- **Refus** : si l'exécuteur lève `ApprovalRefused(reason, details)`, rien n'a eu lieu : l'action repasse en `pending`
  avec `refusal: { reason, details, at, by }` et l'erreur est relancée. Toute autre erreur fait de même avec
  `reason: 'execution_failed'` et est relancée en `ApprovalError('execution_failed')` (l'originale est dans `cause`).
- **Expiration** : `ttlMs` ou `expiresAt` à `propose`. Une action expirée ne peut plus être approuvée ni rejetée
  (`ApprovalError('expired')`), même si le balayage n'est pas encore passé. `expire()` les marque `expired` ;
  appelez-la depuis une minuterie ou une tâche de l'ordonnanceur.
- **Entrée corrigée (1.3.0)** : `approve(id, { decider, input })` approuve l'action *telle que la personne l'a lue et
  corrigée*. `input` doit être un objet ; `validateInput({ action, input, decider })` (option) peut la refuser (`false`
  ou une exception : `ApprovalError('invalid')`) ou la normaliser (`{ value }`). Elle est enregistrée en
  `decisionInput` dans la même réservation atomique, avant toute exécution, et l'exécuteur la reçoit en `input` (la
  proposition reste en `proposedInput`). `authorize` la voit aussi. Un refus ou un échec l'efface avec la réservation.
- **Erreurs** (`ApprovalError.code`) : `not_found`, `expired`, `already_decided`, `forbidden`, `no_executor`,
  `execution_failed`, `invalid`.
- **Stockage PostgreSQL** : `createPostgresApprovalStore(db)` avec `postgresApprovalSchema()` (qui ajoute aussi la
  colonne `decision_input` à une table plus ancienne). Sur **votre propre table** (1.3.0), donnez la correspondance :
  ```js
  createPostgresApprovalStore(db, {
    table: 'journal_actions',
    columns: { id: 'ref', type: 'outil', input: 'entree', requestedBy: 'demandeur', status: 'statut',
      createdAt: 'cree_le', expiresAt: 'expire_le', decidedBy: 'decide_par', decidedAt: 'decide_le',
      executedAt: 'execute_le', result: 'resultat', reason: 'motif', decisionInput: 'entree_validee',
      meta: null, refusal: null },                              // null : non conservé
    statuses: { pending: 'en_attente', approved: 'approuvee', rejected: 'rejetee', expired: 'expiree' },
    scope: { column: 'necessite_accord', value: true }         // seules ces lignes appartiennent à la file
  });
  ```
  Les horodatages sont en `timestamptz` ; `input`, `meta`, `result`, `refusal`, `decision_input` en `jsonb`. Les noms
  sont vérifiés (identifiants simples : lettres, chiffres, `_`, 48 caractères au plus) ; toutes les valeurs passent en paramètres. Les
  lignes hors `scope` ne sont jamais lues ni modifiées. Sans colonne `decisionInput`, `approve` avec `input` est refusé
  (rien ne s'exécute).
- **Votre propre stockage (contrat)** : mémoire par défaut ; tout objet qui a ces méthodes convient. Chaque transition
  est une seule étape atomique qui rend l'action modifiée, ou `null` quand sa condition n'est plus vraie (sans lever
  d'erreur pour cela) :
  - `create(action)` enregistre une nouvelle action (tous les champs, `status: 'pending'`) ; `get(id)` → action ou `null` ;
  - `list({ status?, type?, requestedBy?, limit = 50, before? })` → les plus récentes d'abord (`createdAt` décroissant,
    puis `id`) ;
  - `reserve(id, decidedBy, at, decisionInput)` : `pending` et non expirée à `at` → `approved`, fixe `decidedBy`,
    `decidedAt`, `executedAt: null`, et **garde `decisionInput`** (le rend, `null` s'il est absent ; un stockage qui
    rend `undefined` est refusé quand une entrée est donnée) ;
  - `finish(id, result, at)` : `approved` et `executedAt` nul → fixe `result`, `executedAt` ;
  - `revert(id, decidedBy, refusal)` : `approved` par ce décideur et non exécutée → `pending`, efface `decidedBy`,
    `decidedAt`, `decisionInput`, fixe `refusal` ;
  - `reject(id, decidedBy, reason, at)` : `pending` et non expirée → `rejected` ;
  - `expire(at)` : toute `pending` dont `expiresAt <= at` → `expired` (`decidedAt: at`), et les rend.
  Les instants sont en millisecondes. Avec plusieurs processus, la condition doit être vérifiée dans la même requête
  que le changement (un `UPDATE … WHERE status = 'pending'` conditionnel), pas lue puis écrite.
- Les entrées et résultats conservés doivent être du JSON.

## Tests

`npm test -w @astratra/agent`. Les tests PostgreSQL réels ne tournent qu'avec
`AGENT_TEST_DATABASE_URL` désignant une base dont le nom finit par `_test` ;
sinon ils sont ignorés.
