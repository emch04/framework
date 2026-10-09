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

## Tests

`npm test -w @astratra/agent`. Les tests PostgreSQL réels ne tournent qu'avec
`AGENT_TEST_DATABASE_URL` désignant une base dont le nom finit par `_test` ;
sinon ils sont ignorés.
