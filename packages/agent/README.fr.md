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

## Tests

`npm test -w @astratra/agent`. Les tests PostgreSQL réels ne tournent qu'avec
`AGENT_TEST_DATABASE_URL` désignant une base dont le nom finit par `_test` ;
sinon ils sont ignorés.
