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

## Le sas : un agent propose, un humain dispose

Un agent autorisé à écrire est dangereux d'une façon qu'un agent qui répond
n'est pas. Le mode de panne n'est pas la malveillance, c'est l'assurance : le
modèle appelle `send_email` avec un destinataire plausible et un corps
plausible, et une vraie famille reçoit un vrai message que personne n'a
approuvé.

```js
const { createPendingActions } = require('@astratra/ai');

const sas = createPendingActions({
  store,
  // Seul ce qui figure ici peut JAMAIS s'exécuter.
  tools: {
    send_email: async (payload) => mailer.send(payload),
    send_fee_reminders: async (payload) => finance.remind(payload),
  },
  onPending: (action) => notifier.tell(action),   // « quelque chose attend »
});

// L'agent propose — rien ne part.
await sas.propose({ action: 'send_email', payload, proposedBy: 'agent', dedupeKey });

// Un humain tranche.
await sas.approve(id, { approvedBy: userId, amend: { to: 'bonne-adresse@x.cd' } });
await sas.reject(id,  { rejectedBy: userId, note: 'mauvais destinataire' });
```

`createMemoryActionStore()` fournit un store en mémoire pour les tests et le
développement — non persistant, donc à remplacer par une vraie table dès qu'il
y a plusieurs instances : la revendication atomique n'a de sens que partagée.

Ce que le cycle garantit :

- **une exécution, jamais deux** — la transition vers `executing` est une
  revendication atomique : deux approbations simultanées produisent un envoi ;
- **`dedupeKey`** empêche un modèle insistant d'empiler cinq propositions
  identiques ;
- **`amend`** : l'humain corrige le brouillon du modèle — destinataire, liste —
  et la correction est consignée ;
- un outil qui **retourne** une erreur est marqué `failed`, jamais `executed` :
  « Envoyé » à l'écran pour un message jamais parti est le mensonge que ce sas
  existe pour empêcher ;
- un canal de notification mort ne fait pas échouer l'agent — l'action reste
  visible dans sa liste.

## Le repli déterministe : répondre quand tout est tombé

La norme, quand le dernier fournisseur de la chaîne échoue, est un message
d'erreur. L'alternative est une réponse calculée SANS modèle, depuis les données
qu'on a déjà. Ce n'est pas aussi bien — et ce n'est jamais un écran vide.

```js
const { createDeterministicFallback } = require('@astratra/ai');

const repli = createDeterministicFallback({
  responders: {
    average: async ({ grades }) => ({ text: `La moyenne est de ${mean(grades)}/20.` }),
  },
  classify: (input) => input.question.includes('moyenne') ? 'average' : null,
});

const { degraded, answer, providerError } = await repli.withFallback(
  (input) => router.ask(input),
  input,
);
```

La règle d'honnêteté est la partie qui compte : une réponse de repli **dit**
qu'elle en est une (`degraded: true`). Servir une réponse dégradée comme si de
rien n'était apprend aux utilisateurs à se méfier des bonnes.

Et l'erreur du fournisseur est **transportée**, pas avalée : la gober en
silence cacherait la panne à ta propre supervision. Une question sans réponse
déterministe est déclinée, pas inventée.

## Nettoyer une réponse avant qu'un humain la lise

Une règle écrite dans l'invite n'est qu'un vœu : le modèle la suit quand ça
l'arrange. Trois fuites arrivaient quand même à l'écran — du JSON brut, les
étiquettes d'une structure que le modèle s'est inventée (`**introduction** :`),
et des brouillons de raisonnement ou des relances robotiques en fin de réponse.
`createResponseCleaner` les retire de façon déterministe.

```js
const { createResponseCleaner } = require('@astratra/ai');

const nettoyeur = createResponseCleaner({
  shared: {                        // appliqué quelle que soit la langue
    payloadKeys: ['response', 'message', 'answer'],
    titleKeys: ['title', 'name'],
    lineLabels: ['title', 'introduction', 'features', /key[ _]features/],
    reasoningStarters: ['Wait', 'Actually'],
    finalMarkers: [/Final\s*answer/],
  },
  languages: {
    fr: {
      payloadKeys: ['réponse'],
      closingPhrases: [/Besoin d'autre chose[^.?!]*[.?!]?/],
    },
  },
  fallbackLanguage: 'fr',
});

nettoyeur.clean(texteDuModele, { language: 'fr' });
```

**Aucune clé JSON à l'écran, jamais.** Un ancien convertisseur écrivait
« title : … », « features : … » : les clés restaient visibles. Ici un titre
devient une ligne en gras, un texte un paragraphe, une liste des puces, un
élément nommé « **Nom** — description ». Quand le modèle enveloppe sa réponse
(`{"role": "...", "response": "..."}`), le champ utile EST la réponse.

Les étiquettes de ligne ne sont retirées **qu'en début de ligne** : le même mot
au milieu d'une phrase n'est jamais touché. Pour un brouillon, seul ce qui suit
la **dernière** ligne de raisonnement est gardé. Les relances empilées en fin de
réponse sont retirées en plusieurs passes, bornées (`maxClosingPasses`, 3 par
défaut).

Le paquet ne contient **aucun mot** : chaque entrée est un mot littéral
(échappé) ou une `RegExp`, fournie par l'appelant, par langue. Sans vocabulaire,
seul le nettoyage structurel tourne (blocs `<think>`, JSON, espaces).

## Dire au modèle où part sa réponse

```js
const { createFormatInstructions } = require('@astratra/ai');

const forme = createFormatInstructions({
  languages: {
    fr: {
      heading: '## Où part ta réponse',
      intro: "Ta réponse s'affiche sur {surface}.",
      surfaceNames: { phone: 'un téléphone', tablet: 'une tablette', desktop: 'un navigateur' },
      table: 'Un tableau tient au maximum {columns} colonnes courtes.',
      narrow: "Sur un téléphone, préfère la liste au moindre doute.",
      wide: 'Le tableau reste réservé aux données réellement tabulaires.',
      paragraphs: 'Écris en paragraphes : une idée chacun, des phrases complètes, jamais de trait (---).',
    },
  },
});

forme.build(req.headers['x-surface'], 'fr');
```

Surfaces par défaut : téléphone 3 colonnes, tablette 4, bureau 6. Une surface
absente ou inconnue vaut **téléphone** : se tromper vers le petit coûte une liste
là où un tableau tenait, se tromper vers le grand coûte un tableau illisible.
La règle `paragraphs` est **obligatoire** : un pack de langue qui ne l'a pas est
refusé à la création, pas découvert sur un écran.
