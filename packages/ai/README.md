# @astratra/ai

Routing IA multi-provider générique, registre d'outils et une boucle
d'agent minimale à tool-calling. Dépend de `@astratra/core`.

Ce package ne fournit volontairement aucun catalogue de modèles, aucun SDK
provider, aucun outil métier — tout ça vient du projet consommateur. Ce
qu'il fournit, c'est le mécanisme durement acquis : suivi de quota, ordre de
fallback, cooldown/dégradation, deux adaptateurs HTTP sans dépendance (le
format OpenAI et Gemini), et deux boucles d'agent (protocole écrit, ou
appels d'outils natifs).

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

### L'ordre d'une demande, et qui a répondu

Un même projet a souvent plusieurs ordres pour les mêmes modèles : le plus
rapide d'abord pour ce que la personne attend, le plus capable d'abord pour
le reste, ceux qui voient seulement pour une photo. `route` dit en plus qui a
répondu (pour les journaux).

```js
const router = createProviderRouter({
  providers,
  cooldownMs: 120_000,
  cooldownJitterMs: 0,
  // Ce qui met au repos : un 429 par défaut ; ici aussi un 503 et un délai dépassé.
  cooldownOn: (error) => [429, 503].includes(error.statusCode) || error.name === 'TimeoutError',
  // Tous au repos ? On les essaie quand même : un repos est une supposition.
  whenAllCooling: 'try'
});

const { value, key, partial } = await router.route(requete, {
  candidates: [{ provider: 'groq', model: 'qwen/qwen3.8-27b', extra: { reasoning_format: 'hidden' } }, { provider: 'gemini', model: 'gemini-3.6-flash' }],
  select: (model, provider) => provider.id === 'gemini' || model.vision === true, // une photo : ceux qui voient
  accepts: (reponse) => Boolean(reponse.text),                                   // refusée : le suivant
  partial: (reponse) => reponse.cut === true                                     // coupée : en dernier recours
}, { signal, purpose: 'chat' });
```

- Un fournisseur dont `available(ctx)` est faux (pas de clé) est sauté sans
  bruit ; aucun disponible : `code: 'AI_NO_PROVIDER'`. Aucun qui convienne à
  `select` : `'AI_NO_MATCH'`. Tous essayés : `'AI_UNAVAILABLE'` (AppError 503).
- Une réponse refusée par `accepts` passe au modèle suivant sans compter comme
  une panne ; une réponse `partial` n'est rendue que si personne ne finit.
- Une **voie** (`provider.lane(ctx)`) : une clé à part pour un usage, avec son
  propre quota. Elle se repose seule (`"gemini:modèle@news"`) : une clé saturée
  par un travail de fond n'arrête jamais les conversations.
- `ctx.signal` interrompu : la demande s'arrête net avec la raison de
  l'appelant, aucun modèle suivant n'est demandé et aucun ne se repose.
- `now` injecte l'horloge des repos ; `reset()` les oublie. Le minuteur de
  minuit ne garde jamais le processus en vie.

### Les adaptateurs : format OpenAI et Gemini

```js
const { createGeminiProvider, createOpenAICompatibleProvider } = require('@astratra/ai');

createGeminiProvider({
  getKey: (ctx) => ctx.env[`GEMINI_API_KEY_${ctx.purpose}`] || ctx.env.GEMINI_API_KEY,
  lane: (ctx) => (ctx.env[`GEMINI_API_KEY_${ctx.purpose}`] ? ctx.purpose : null),
  fetch, detailed: true, toRequest: (requete) => requete
});
createOpenAICompatibleProvider({
  id: 'cloudflare',
  url: (ctx) => ctx.env.CF_ACCOUNT && `https://api.cloudflare.com/client/v4/accounts/${ctx.env.CF_ACCOUNT}/ai/v1/chat/completions`,
  getKey: (ctx) => ctx.env.CF_TOKEN, fetch, detailed: true, toRequest: (requete) => requete
});
```

Les deux prennent la même requête (`{ system, messages, tools, maxTokens }`,
photos comprises) et rendent la même réponse : `detailed: true` rend
`{ text, toolCalls, cut }` au routeur, qui juge. La clé et l'adresse sont
relues à chaque appel (`ctx`) ; `ctx.fetch` et `ctx.timeoutMs` valent pour un
appel ; `extra` d'un modèle s'ajoute à celui du fournisseur. Gemma reçoit la
consigne en tête du premier message ; les parties de réflexion et les balises
`<think>` (même fermée sans ouverture) ne sont jamais montrées ; un appel
d'outil **écrit dans le texte** (façons de Qwen et de Hermes) devient un vrai
appel — et n'est jamais une réponse à montrer. Des arguments illisibles gardent
l'appel, marqué `invalid` avec `invalidReason` (`not_json`, `not_object`), et
repartent en `{}` au tour suivant.

## Outils natifs : la boucle d'un agent qui appelle ses outils

```js
const { createToolCaller, runToolLoop, toolSpecs, validateNativeTools } = require('@astratra/ai');

const outils = validateNativeTools(catalogue, { requireSummary: true }); // au démarrage
const appeler = createToolCaller({
  tools: outils, context: { userId }, signal, timeoutMs: 20_000,
  emit: flux.send,                   // 'step' { id, tool, params } puis 'step_done' { id, ok }
  keep: sources.keep,                // createSourceLedger()
  record: async ({ tool, args, found }) => garderAction(tool, args, found), // à confirmer, à annuler
  messages: { waiting: 'Rien n’est écrit : la personne doit confirmer sur son téléphone.' }
});
const { text } = await runToolLoop({
  system, messages, tools: toolSpecs(outils), turn, callTool: appeler,
  maxTurns: 6, maxMs: 60_000, finalInstruction: 'Answer now with what you have read: no more tools.', signal
});
```

Un outil : `{ name, description, parameters, kind, summary?, run }`, avec
`perform` pour un outil `confirm` (rien n'est écrit avant qu'un humain
confirme ; le modèle lit que ça attend) et `undo` pour un outil `write`. Un
outil qui lève, qui tarde, qu'on invente, ou des arguments illisibles
deviennent une erreur que le modèle **lit** et corrige au tour suivant ; ce
qu'un outil rend est borné (`resultMax`, 6 000). Les outils demandés ensemble
tournent en même temps. À court de tours ou de temps, un dernier tour sans
outils répond avec ce qui a été lu ; un tour sans texte ni outil lève
`code: 'AI_NO_ANSWER'`, pour que l'appelant réponde autrement.
`summary(args)` donne les valeurs de la ligne d'étape (`stepParams`, coupées à
120 caractères) : l'interface écrit la phrase, le serveur n'en écrit aucune.

## Le flux vers l'app (server-sent events)

```js
const flux = openEventStream(res);   // Node ou Express
flux.send('step', { id: 's1', tool: 'read_bible' });
flux.close();
flux.signal;                          // interrompu quand la personne part — pas quand le serveur ferme
```

Chaque bloc s'écrit `event: <type>\ndata: <json>\n\n`, sans mise en tampon par
un proxy (`X-Accel-Buffering: no`) ; écrire après la fin ne fait rien.

## Recherche web (Serper)

```js
const resultats = await searchSerper({ query, sites: ['jw.org'], hl: 'fr' }, {
  key: process.env.SERPER_API_KEY, fetch,
  accept: (resultat, url) => !estHostile(resultat)   // écarté avant que le modèle ne lise
});
```

Des résultats https avec un titre, 8 au plus. Sans clé, rien n'est demandé
(`code: 'WEB_SEARCH_NO_KEY'`) ; une panne porte `'WEB_SEARCH_FAILED'`, jamais la clé.

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

## Un disjoncteur par fournisseur, jamais un pour tous

Un seul disjoncteur partagé par toutes les dépendances extérieures a l'air
propre et c'est un piège : un reclasseur lent l'ouvrait, et le détecteur de
noms derrière le masquage s'éteignait avec lui pendant une minute. Ce qui
tombe doit être seul à s'arrêter.

Le paquet n'a pas de disjoncteur à lui : celui de `@astratra/resilience` (une
seule sonde en demi-ouverture) s'injecte.

```js
const { createCircuitBreaker } = require('@astratra/resilience');
const { createProviderRouter, isProviderOutage } = require('@astratra/ai');

const router = createProviderRouter({
  providers,
  breakers: (id) => createCircuitBreaker({ name: id, failureThreshold: 3, recoveryMs: 60_000, isFailure: isProviderOutage })
});
router.getStats()['groq:llama'].circuit; // 'closed' | 'open' | 'half-open'
```

`isProviderOutage` : délais, erreurs réseau, 408 et 5xx sont des pannes ; un
429 ne l'est pas (le refroidissement du routeur s'en charge), ni un 400/401/404
(c'est la requête ou la clé, pas le fournisseur). Un appel refusé par le
disjoncteur ne consomme aucun quota et ne compte pas comme échec du modèle.
`createBreakerPool` sert pour tout le reste (routes d'un service local de
modèles…) et **refuse une fabrique qui rendrait le même disjoncteur pour deux
clés** — c'est exactement le disjoncteur partagé.

## Masquer ce qui sort, démasquer ce qui revient

La question était masquée ; la recherche web ne l'était pas. Le modèle écrivait
la requête à partir de la question masquée, la boucle démasquait les paramètres
pour les outils qui ont besoin des vrais noms — et le nom de l'enfant partait
en clair chez le moteur de recherche. La règle porte donc sur la **direction** :
ce qui quitte la machine est masqué au moment où il la quitte.

```js
const { createReversibleMasker } = require('@astratra/ai');

const masker = createReversibleMasker({
  names: registreDeLEcole,                                // sensible à la casse
  patterns: [{ type: 'EMAIL', pattern: /[\w.+-]+@[\w-]+\.[\w.]+/g }],
  detect: (texte) => serviceLocal.entites(texte),         // NER local, jamais distant
});

// Routeur : un fournisseur externe reçoit le texte masqué, la réponse revient démasquée
// (y compris en flux). Un fournisseur `external: false` (sur la machine) reçoit le clair.
await router.ask(question, { complexity: 'simple' }, { masker });

// Boucle d'agent : un outil `external: true` reçoit des paramètres MASQUÉS.
registry.register({ name: 'web_search', external: true, /* … */ });
await runAgentLoop({ prompt, registry, router, userRole, masker });
```

Un masqueur par conversation ; il **apprend** : un nom trouvé une fois est
masqué partout ensuite, avec le même jeton. Le registre est comparé en
respectant la casse et sur des mots entiers (« Grace » masqué, « grâce à »
intact), un nom de moins de trois lettres n'est jamais masqué, un nom absent du
texte ne crée aucun jeton, les détections sous 0,6 sont ignorées et le
détecteur ne reçoit que 1 500 caractères coupés sur un blanc. Au démasquage, un
modèle qui a perdu le `#` du jeton récupère quand même le nom, et
`#PERSON_0001` ne mange jamais le début de `#PERSON_00012`.

## Des passages dans une autre langue

Une question en anglais peut trouver sa meilleure réponse dans un texte qui
n'existe qu'en français. Chaque passage dit sa langue (`[fr]`) et une consigne
— la tienne, par langue — demande de traduire ce qui sert **en gardant la
référence d'origine**.

```js
const lignes = buildPassagesContext({
  passages,            // null = la recherche a échoué : on ne dit rien de la bibliothèque
  lang: 'en',
  texts: { header, footer, empty, foreign: 'A passage marked {languages} … keep its original reference.' }
});
```

`fr-FR` et `fr` sont la même langue (sous-étiquette principale). Un passage
étranger sans consigne est refusé plutôt que laissé à deviner au modèle.

## Les sources : lues, utilisées, contredites

- `createSourceLedger()` collecte les sources rendues par les outils ; un outil
  qui en rend plusieurs ne rattache pas toute sa sortie à chacune.
- `usedSources(réponse, sources, preuves, options)` ne garde que celles sur
  lesquelles la réponse s'appuie (son lien, une référence nommée des deux
  côtés, assez de mots distinctifs communs). Rien n'est jamais ajouté.
- `findContradiction(réponse, extraits, { compare })` confronte chaque phrase
  factuelle à l'extrait le plus proche via un modèle d'inférence local ; seule
  une contradiction franche compte, un doute, une panne ou un délai dépassé ne
  disent rien (`null`).
- `rerankResults(question, trouvés, { score })` range les résultats par
  pertinence et les sources suivent ; sans score, l'ordre du moteur reste.

## Le texte de la réponse

`tidyMarkdown` ramène la réponse au Markdown qu'un téléphone dessine (avec
`remove`, des expressions que l'app ne montre jamais), `plainText` l'enlève
pour une voix, `wholeSentences` ramène un texte coupé à sa dernière phrase
entière, et `verifyQuotations(texte, { findReferences, resolve })` remplace une
citation infidèle suivie de sa référence par le vrai texte — ce qu'est une
référence et où vit son texte t'appartient.

## La langue de la réponse, la cadence, les points compatibles OpenAI

- `createLanguageDetector({ words, identify })` : les petits mots d'abord (un
  « merci » ne se devine pas autrement), puis un identifiant injecté, cru
  seulement au-dessus d'un seuil — bien plus haut pour deux mots.
- `createAskLimit({ max, windowMs, code })` : fenêtre glissante par personne ;
  le refus porte un code et l'attente, jamais une phrase ; les comptes qui
  n'écrivent plus sont oubliés (toutes les 500 demandes, et dès qu'une fenêtre
  est passée depuis le dernier nettoyage).
- `createOpenAICompatibleProvider({ id, url, getKey, models, fetch })` : un
  fournisseur pour le routeur. La clé est relue à chaque appel, une erreur porte
  le statut HTTP (429 → refroidissement) et jamais la clé, des arguments d'outil
  mal formés sont signalés (`invalid: true`) au lieu de faire tomber le tour, les
  balises de réflexion ne sont jamais montrées.

## La boucle d'agent : outils en panne, budget de temps, dernier tour

```js
await runAgentLoop({
  prompt, registry, router, userRole,
  reportToolErrors: true,   // un outil qui lève devient { error: 'tool_failed' } pour le modèle
  toolTimeoutMs: 20_000,    // … ou { error: 'tool_timeout' }
  maxMs: 60_000,            // budget total
  finalInstruction: 'Réponds maintenant avec ce que tu as lu, sans outil.'
});
```

Le modèle lit un code, jamais le message d'erreur. À court de tours ou de
temps, un dernier tour sans outils répond avec ce qui a été lu, plutôt qu'une
erreur.

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
