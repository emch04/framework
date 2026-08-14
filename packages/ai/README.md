# @astratra/ai

Routing IA multi-provider générique, registre d'outils et une boucle
d'agent minimale à tool-calling. Dépend de `@astratra/core`.

Ce package ne fournit volontairement aucun catalogue de modèles, aucun SDK
provider, aucun outil métier — tout ça vient du projet consommateur. Ce
qu'il fournit, c'est le mécanisme durement acquis : suivi de quota, ordre de
fallback, cooldown/dégradation, et une petite boucle d'orchestration
d'agent.

## Routeur de providers

```js
const { createProviderRouter } = require('@astratra/ai');

const router = createProviderRouter({
  redisUrl: process.env.REDIS_URL,  // optionnel — quotas atomiques partagés entre instances
  intentRouting: {
    summarize: { preferred: ['fast-model'] }
  },
  providers: [
    {
      id: 'mon-provider-llm',
      models: [{ id: 'fast-model', rpm: 30, rpd: 1000, tpd: 200000, complexity: ['simple', 'medium'] }],
      call: async (prompt, ctx, model) => monClient.complete(model.id, prompt)
    }
  ]
});

const reponse = await router.ask('Résume ceci.', { complexity: 'simple', estimatedTokens: 200 });
router.getStats();  // usage RPM/RPD/TPD par "providerId:modelId", état cooldown/dégradé
router.stop();      // arrête le timer de reset minuit et ferme le lien Redis, s'il existe
```

Les providers sont essayés dans l'ordre du tableau que vous fournissez —
l'ordre de fallback est votre décision, pas figé dans le package. Les
quotas RPM/RPD/TPD, le cooldown après 429 avec jitter et la dégradation
après échecs répétés sont suivis par couple `providerId:modelId`. Avec
`redisUrl`, la réservation des quotas est atomique entre instances avant
l'appel du provider. Sans Redis, ou si Redis devient indisponible, le routeur
continue avec des compteurs RAM locaux : ce repli ne peut pas garantir un
quota distribué. Les compteurs journaliers se réinitialisent automatiquement
à minuit.

## Registre d'outils

```js
const { createToolRegistry } = require('@astratra/ai');

const registry = createToolRegistry();
registry.register({
  name: 'get_patient_record',
  description: "Récupère le dossier d'un patient par son id",
  type: 'read',
  roles: ['doctor', 'admin'],
  params: { patientId: 'string' },
  handler: async ({ patientId }, ctx) => patientStore.findById(patientId)
});
```

Vide par défaut — aucun outil pré-enregistré. `registry.formatToolsForPrompt(role)`
formate en texte les outils visibles pour un rôle donné, à injecter dans un
prompt système.

## Boucle d'agent

```js
const { runAgentLoop } = require('@astratra/ai');

const reponse = await runAgentLoop({
  prompt: 'Quel est le solde du patient X ?',
  ctx: { tenantId: 'clinic-1' },
  registry,
  router,
  userRole: 'doctor',
  maxSteps: 5,
  onChunk: (chunk) => res.write(chunk),           // streaming token par token, optionnel
  confirmTool: async (toolCall) => askUser(toolCall) // confirmation avant exécution, optionnel
});
```

Parse `<tool_call name="...">{...json...}</tool_call>` dans la réponse du
modèle, exécute l'outil correspondant enregistré (refuse si le rôle n'y a
pas accès), réinjecte le résultat sous forme de `<tool_result>`, et boucle
jusqu'à une réponse finale ou `maxSteps` atteint.

`onChunk(chunk)` est appelé pour chaque morceau reçu si `router.ask()`
retourne un flux (async iterable) — un vrai passthrough token par token vers
ton UI. La boucle continue d'accumuler le texte complet en interne (elle en
a besoin pour détecter un `<tool_call>`), donc le fournir ne change rien au
comportement, juste un point d'observation en plus.

`confirmTool(toolCall, ctx)` est attendu avant l'exécution d'un appel d'outil
détecté. Retourne `false` (ou une promesse résolue en `false`) pour refuser
— la boucle ne plante pas, elle informe le modèle (`{"denied": true, ...}`
comme résultat d'outil) et continue, il peut réagir (expliquer, proposer
autre chose, s'arrêter). Omis, chaque outil autorisé s'exécute automatiquement,
comme avant.

**Périmètre V0 — toujours volontairement exclu :** gestion d'images/vision.
Fonctionnalité non triviale dont une boucle d'agent de production a besoin,
mais dont le portage fidèle reste jugé trop ambitieux pour ce package. À
construire dans votre propre boucle, ou à couvrir dans un futur spec.

## Tests

```bash
npm test --workspace @astratra/ai
```
