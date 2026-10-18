# @astratra/ai

Routing IA multi-provider générique, registre d'outils et une boucle
d'agent minimale à tool-calling. Dépend de `@astratra/core`.

Ce package ne fournit volontairement aucun catalogue de modèles, aucun SDK
provider, aucun outil métier — tout ça vient du projet consommateur. Le routeur
configuré, les clients de modèles locaux et les services vocaux ci-dessous
partagent désormais les mécanismes utilisés par deux assistants d'IA en production. Ce
qu'il fournit, c'est le mécanisme durement acquis : suivi de quota, ordre de
fallback, cooldown/dégradation, deux adaptateurs HTTP sans dépendance (le
format OpenAI et Gemini), et deux boucles d'agent (protocole écrit, ou
appels d'outils natifs).

## Gardes d'agent / Agent guards (`@astratra/ai/guards`)

Protections prêtes à brancher sur un agent, indépendantes du fournisseur d'IA.
Elles s'appuient sur le client de `@astratra/models` **injecté** (`models`) :
aucune dépendance dure. `@astratra/rag` (`verifySources`) est une dépendance
de pair facultative, ou s'injecte avec l'option `verifySources`.

```js
const { recommendedGuards } = require('@astratra/ai/guards');
const { createModelsClient, assertModelsReady } = require('@astratra/models');

assertModelsReady({ required: ['entities', 'injection', 'moderation', 'nli'] }); // en production, refuse de partir sans les modèles
const guards = recommendedGuards({ models: createModelsClient({ token: () => process.env.MODELS_TOKEN }), onEvent: log });

const run = guards.newRun();                                  // une par conversation ou exécution d'agent
const safe = await guards.input(question, run);               // noms et données personnelles masqués, réversible
if (safe.decision === 'block') return refuse();
// ... l'agent appelle ses outils ...
const seen = await guards.toolResult(page, run, { tool: 'web_search', external: true });
messages.push({ role: 'tool', content: seen.content });       // masqué, encadré comme donnée non fiable
const action = await guards.beforeAction({ name: 'send_email' }, run);
if (action.decision === 'block') askAHuman();                 // après une injection suspectée : jamais sans humain
const reply = await guards.output(modelAnswer, run);          // démasqué, puis ancrage, fuite, modération
```

| Garde | Ce qu'elle fait |
|---|---|
| `input(text, run)` | masque les noms (détecteur d'entités + `names` du registre) et les données structurées (e-mail, IBAN, carte, téléphone) ainsi que les secrets (clés d'API, jetons JWT, clés privées, adresses IP) ; le texte revient démasqué dans `output`. Rend `text: null` si elle bloque. |
| `toolResult(result, run, { tool, external })` | pour un résultat **externe** (ou marqué `{ untrusted: true, content }`) : détection d'injection (texte long lu par fenêtres, jamais passé sans contrôle), contenu encadré par des marqueurs à nonce comme *données non fiables*. Injection suspectée : `run.requiresConfirmation = true` pour tout le reste de l'exécution. |
| `output(text, run)` | démasque ; **ancrage** (chaque phrase contre les sources lues, NLI, via `verifySources` de rag) avec `groundingScore` et la liste `unsupported` ; **fuite** de données personnelles que la personne n'a pas données (`onLeak`: `block`, `redact`, `flag`) ; **modération**. |
| `beforeAction(action, run, { humanConfirmed })` | refuse toute action tant qu'une injection est suspectée et qu'aucun humain n'a confirmé (`humanConfirmed: true` vient de votre interface, jamais du modèle). |

**Panne** : `policy.failure = { action: 'failClosed', read: 'failClosed' }` par
défaut (bloquer et signaler). `failOpen` laisse passer en signalant
`degraded` ; `recommendedGuards({ readOnly: true })` l'applique à un agent qui
ne fait que lire. Le mode d'une exécution est `newRun({ mode: 'action' | 'read' })`.

**Événements** : chaque décision appelle `onEvent({ type: 'guard', guard, decision,
reasons, degraded, metrics, runId, mode, at })`. Ils ne contiennent jamais le
texte (ni saisie, ni résultat d'outil, ni réponse) : des nombres, des codes et
des noms de catégories. La réponse de `output` rend, elle, les phrases non
soutenues à l'appelant.

**Tests** : `@astratra/ai/guards/testing` fournit `createFakeModels` (un client
sans modèle : règles par mots-clés, pannes simulées), `createMockGuards` (les
vraies gardes sur ce client, avec un enregistreur d'événements) et
`createEventRecorder`.

Limites : les gardes réduisent le risque, elles ne le suppriment pas. Les
règles de fuite ne couvrent que les données structurées et les secrets à forme
connue (`findPersonalData` : `email`, `iban`, `card`, `phone`, `apiKey` —
OpenAI, Anthropic, Google, GitHub, Stripe, AWS, Slack, Groq, Hugging Face —,
`jwt`, `privateKey`, `ip`) ; une clé sans préfixe reconnaissable passe. Une
clé ou une adresse IP n'est jamais lue à moitié comme un téléphone ou une
carte. L'ancrage compte
aussi comme « non soutenues » des phrases de liaison ; la détection d'injection
lit un texte isolé.

English: ready-to-use guards for an agent, independent of the AI provider.
Inject the `@astratra/models` client as `models`; nothing is imported. `input`
masks names and personal data (reversible), `toolResult` scans untrusted
content for injection, frames it as untrusted data and, when an injection is
suspected, forbids every action without a human for the rest of the run
(`beforeAction`), `output` unmasks the reply and checks grounding against the
sources, personal-data leaks and moderation. Failure policy is `failClosed` for
actions by default, `failOpen` possible for read-only runs. Events never carry
the text. Mocks for tests: `@astratra/ai/guards/testing`.

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

**Signatures de pensée (Gemini 3, 1.12.0)** : chaque appel d'outil de Gemini 3
porte une signature, à rendre telle quelle au tour suivant, sinon Gemini répond
400. Elle arrive dans `toolCalls[i].signature` (directement chez Gemini, par
l'API compatible OpenAI de Google, ou par la passerelle Centrale) : **gardez
l'appel tel quel** dans le message `assistant` de l'historique, elle repart
avec lui (`thoughtSignature` chez Gemini, `extra_content.google.thought_signature`
au format OpenAI). Au format OpenAI, elle n'est envoyée qu'à `*.googleapis.com`,
ou à une cible qui le demande : `thoughtSignatures: true` (dans la cible
d'`askChatModel` ou les options de `createOpenAICompatibleProvider` ;
`modeleDiscussion()` de `@astratra/centrale` 1.7.0 le donne) ; jamais à un
autre fournisseur, qui pourrait refuser le champ. Un premier appel sans
signature (venu d'un autre fournisseur) part chez Gemini avec la valeur de
contournement de Google (`skip_thought_signature_validator`), sauf pour Gemma.

### La réponse petit à petit (`onText`)

Passé dans le contexte de `route()` (`router.route(requete, options, { onText })`) ou dans `io` d'`askChatModel` /
`askGeminiModel`, `onText` demande la réponse en flux (`stream: true` au format OpenAI, `streamGenerateContent` chez
Gemini) et reçoit le texte montrable **entier** à chaque avancée :

- jamais la réflexion (balises think, parties `thought` de Gemini), jamais une balise coupée en deux ;
- rien quand le modèle écrit un appel d'outil dans son texte ou commence par du JSON ;
- au modèle suivant du routeur, le texte repart de zéro et remplace le précédent ;
- la valeur rendue (texte, appels d'outils, `cut`, sources) est la même que sans flux ;
- jamais passé à un fournisseur masqué : un texte masqué ne se montre pas en cours de route.

```js
await router.route(requete, { accepts }, { onText: (texte) => ecrireBrouillon(texte) });
```

### La recherche Google intégrée de Gemini

`googleSearch` sur une requête active l'outil de recherche de Gemini
(`google_search` dans generateContent). Les fournisseurs au format OpenAI
l'ignorent. Le fournisseur `detailed` rend alors `grounding` : les recherches
faites et les pages citées, sous une forme stable.

```js
const { value } = await router.route({
  system, messages, tools,
  googleSearch: true // ou { functions: 'auto' | 'combine' | 'alone' }
});
// value.grounding = { searched, queries: ['…'], sources: [{ title, url }],
//                     searchSuggestionsHtml, functionsDropped }
```

Avec les fonctions de l'application : `combine` envoie les deux outils
ensemble ; `alone` n'envoie que la recherche pour ce tour (aucun appel de
fonction n'est lu) ; `auto` (défaut) les envoie ensemble et, si l'API refuse le
mélange (400), redemande avec la recherche seule — `functionsDropped: true` le
dit. Selon le modèle, l'API accepte ou non le mélange : `auto` couvre les deux.

Les pages lues sont des **données non fiables**. Le paquet n'en rend que des
titres (une ligne, 200 caractères au plus, caractères de contrôle retirés) et
des adresses `http(s)` sans identifiants, dédoublonnées (20 pages, 10 recherches
au plus) ; il ne les relit jamais comme des consignes et ne les remet jamais
dans un message. `readGeminiGrounding(réponse)` fait la même lecture sur une
réponse brute. Google demande d'afficher ses suggestions de recherche avec une
réponse sourcée : `searchSuggestionsHtml` les rend telles quelles, à afficher
dans un cadre isolé.

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
  risk: 'LOW', // LOW, MEDIUM ou HIGH ; absent = UNKNOWN
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

### Garde-fous de la boucle, résultats volumineux et risque

Les appels répétés avec le même nom et les mêmes paramètres JSON (l'ordre des
clés d'objet ne compte pas) reçoivent un rappel aux répétitions 3 et 5, puis
la boucle s'arrête à 8. Ces seuils se règlent avec `loopGuard`; `onEvent`
reçoit `tool_loop_warning` ou `tool_loop_stopped`. Le nombre d'étapes par
défaut reste 5 : l'arrêt à 8 ne joue que si `maxSteps` est réglé à 8 ou plus.

```js
await runAgentLoop({
  prompt, registry, router, userRole: 'doctor',
  loopGuard: { reminder: 3, firmReminder: 5, stop: 8 },
  spill: { threshold: 12_000 },
  confirmationPolicy: { threshold: 'HIGH' },
  riskAnalyzers: [async (call, ctx, tool) => classifier(call, ctx, tool)],
  pendingActions
});
```

Au-dessus du seuil (`spill.threshold`, 12 000 caractères par défaut), le
résultat complet est écrit dans `spill.store` (stockage mémoire par défaut).
Le modèle reçoit un extrait et un identifiant, puis peut appeler
`read_spilled_result` avec `{ id, start, length }` pour lire une tranche. Si
l'écriture échoue, le contenu est supprimé de la réponse et le modèle reçoit
`result_storage_failed`. Un stockage injecté expose `set(id, value)` et
`get(id)`.

Les risques possibles sont `LOW`, `MEDIUM`, `HIGH` et `UNKNOWN` (valeur des
outils sans déclaration). La politique de confirmation est inactive par
défaut, pour préserver l'exécution existante. Elle accepte `'always'`,
`'never'` ou `{ threshold: 'MEDIUM' }`; dans ce dernier cas, les risques au
moins aussi élevés que le seuil, dont `UNKNOWN`, demandent une confirmation.
Les `riskAnalyzers` reçoivent l'appel, le contexte et l'outil ; le niveau le
plus élevé entre l'outil et les analyseurs l'emporte. Les appels à confirmer
sont enregistrés par `pendingActions.propose()` et attendent l'approbation
via le cycle de vie déjà fourni par `createPendingActions`.

**Vision :** les adaptateurs HTTP et `runToolLoop` acceptent les images.
`createConfiguredRouter` les filtre selon les capacités déclarées. La boucle
textuelle historique `runAgentLoop` garde son protocole de texte.

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
  detect: (texte) => serviceLocal.entities(texte, ['person']),         // NER local, jamais distant
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

## llama.cpp : un modèle sur CPU, sur ton VPS

Fournisseur « **llama.cpp server** » : un modèle qui tourne sur **CPU** (un VPS
sans GPU) derrière l'API compatible OpenAI de `llama-server`. Aucune dépendance
(`src/llamaCpp.js`). C'est un client ; il ne lance rien. Le serveur se lance avec
le `docker-compose` de `deploy/llama-cpp/`. Ce n'est pas un doublon de
`createOpenAICompatibleProvider` : celui-ci branche un modèle dans le routeur et
rend `{ status }` pour une erreur HTTP, alors qu'un serveur hébergé par toi a
besoin de sa santé, du chargement du modèle (503) et d'erreurs typées.

### Client

```js
const { createLlamaCppProvider } = require('@astratra/ai');

const llm = createLlamaCppProvider({
  baseUrl: 'http://127.0.0.1:8080',   // avec ou sans /v1
  apiKey: process.env.LLAMA_API_KEY,
  model: 'local',                      // l'alias donné au serveur (facultatif)
  timeoutMs: 120_000,
});

await llm.waitUntilReady({ timeoutMs: 120_000 }); // le chargement du modèle prend du temps
console.log(await llm.health());                  // { ok, status: 'ok'|'loading'|'unauthorized'|'error'|'unreachable'|'timeout', latencyMs }
console.log(await llm.listModels());              // [{ id: 'local', ownedBy: 'llamacpp' }]

const { text, usage } = await llm.chat([{ role: 'user', content: 'Bonjour' }], { temperature: 0.2 });
for await (const piece of llm.chatStream([{ role: 'user', content: 'Raconte-moi une histoire' }])) process.stdout.write(piece);

llm.toOpenAICompatible(); // { baseURL: '…/v1', apiKey, model } pour tout autre client compatible OpenAI
```

`health()` ne lance jamais d'exception (c'est une sonde). Les autres appels
lancent `LocalLlmError` avec `code` : `UNREACHABLE`, `TIMEOUT`, `UNAUTHORIZED`,
`LOADING` (503, modèle pas chargé), `HTTP_ERROR` (avec `status`), `INVALID_RESPONSE`.

### Lancer `llama-server` sur un VPS CPU

Image officielle : `ghcr.io/ggml-org/llama.cpp:server` (CPU ; épingle un tag
`server-b<numéro>` en production).

```bash
cd packages/ai/deploy/llama-cpp
cp .env.example .env            # remplis LLAMA_API_KEY (longue valeur aléatoire) et LLAMA_MODEL_FILE
mkdir -p models                  # y déposer le fichier .gguf (quantisation Q4_K_M : bon compromis)
docker compose up -d
docker compose logs -f llama     # attendre « server is listening »
curl -H "Authorization: Bearer $LLAMA_API_KEY" http://127.0.0.1:8080/v1/models
```

Points à régler :

- **`LLAMA_THREADS`** : cœurs *physiques*, pas vCPU. Trop de fils ralentit.
- **`LLAMA_PARALLEL`** : requêtes simultanées. Le contexte (`LLAMA_CTX`) est
  **partagé** : chacune dispose de `LLAMA_CTX / LLAMA_PARALLEL` jetons.
- **Mémoire** : prévoir la taille du fichier .gguf + ~1 à 2 Go pour le contexte ;
  `LLAMA_MEMORY_LIMIT` plafonne le conteneur.
- **Débit** : sur CPU, un modèle de 3 à 4 milliards de paramètres en Q4 donne de
  l'ordre de quelques à une dizaine de jetons par seconde selon le VPS ; à
  mesurer sur le tien avant de promettre quoi que ce soit.
- Le port n'est publié que sur `127.0.0.1` : l'ouverture au public passe par un
  proxy avec TLS, et la clé API reste obligatoire.
- La clé est lue dans l'environnement (`LLAMA_API_KEY`), jamais en argument.

### Limites

Pas de répartition de charge ni de repli intégrés au client : pour router ce
serveur avec les autres fournisseurs, donne `toOpenAICompatible()` (adresse et clé)
à `createOpenAICompatibleProvider`. Testé avec un faux
serveur HTTP ; le vrai `llama-server` n'a pas été lancé dans ce dépôt.

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

## Configured routing (two production assistants)

`createConfiguredRouter` builds HTTP providers and routes by usage on top of
`createProviderRouter`. Existing exports and their defaults remain compatible.
The model catalogue belongs to your application: names, quotas and capabilities
are explicit configuration, not historical assumptions baked into the package.

```js
const { createConfiguredRouter } = require('@astratra/ai');
const router = createConfiguredRouter({
  providers: [
    { id: 'groq', format: 'openai',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      keys: () => [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2],
      models: [{ id: 'your-fast-model', rpm: 30, rpd: 1000, tpd: 200000,
        complexity: ['simple', 'medium'], extra: { include_reasoning: false } }] },
    { id: 'gemini', format: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      keys: () => [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2],
      keysByUsage: { news: () => [process.env.GEMINI_NEWS_KEY] },
      vision: true,
      models: [{ id: 'your-vision-model', rpm: 10, rpd: 200 }] },
    { id: 'ollama', format: 'openai', local: true,
      url: 'http://127.0.0.1:11434/v1/chat/completions',
      models: [{ id: 'your-local-model' }] }
  ],
  usages: {
    quick: [{ provider: 'groq', model: 'your-fast-model' }, { provider: 'ollama', model: 'your-local-model' }],
    chat: [{ provider: 'gemini', model: 'your-vision-model' }, { provider: 'groq', model: 'your-fast-model' }],
    tools: [{ provider: 'groq', model: 'your-fast-model' }], // pilot is an alias list
    json: [{ provider: 'groq', model: 'your-fast-model', extra: { response_format: { type: 'json_object' } } }],
    vision: [{ provider: 'gemini', model: 'your-vision-model' }]
  },
  intentRouting: { report: { preferred: ['gemini:your-vision-model'] } },
  quotaMargin: { rpm: 0.75, rpd: 0.90, tpd: 0.85 },
  tokenBuffer: 1.2, cooldownMs: 120000, maxFailures: 3, degradedMs: 300000,
  waitedTimeoutMs: 12000, backgroundTimeoutMs: 45000,
  statePrefix: 'my-app:', whenAllCooling: 'skip'
});

const result = await router.route({
  system: 'Answer from the supplied information.',
  messages: [{ role: 'user', text: 'Compare these proposals.' }], maxTokens: 1200
}, { usage: 'chat', waitedOn: true, intent: 'report', signal });
// { value: { text, toolCalls, cut }, provider, model, key, stateKey,
//   usage, complexity, partial, fallback }
await router.ask('Hello');             // detailed answer only
await router.getStats();              // async, counters and rests; never credentials
await router.reset();                 // only state keys used by this router
router.stop();                        // rejects subsequent calls; no owned DB connection
```

Without `usage`, tools select `tools`, images select `vision`, explicit `json:
true` selects `json`, simple requests select `quick`, and the rest selects
`chat`. `estimateRequestComplexity` retains the word/keyword rules of the reference assistant (with
English equivalents); you can override `complexity`. Within a list, intent
preferences come first, then compatible complexity, then other models; preview
models come last. Without a usage list, provider/model declaration order is the
fallback order. Thus one assistant's Groq → Mistral → Gemini → Vercel → Ollama and
another assistant's distinct quick/chat/pilot orders are both expressible.

Model fields: `vision`, `visionOnly`, `complexity`, `extra`, `maxTokens`,
`maxInputTokens`, `noAnalytics`, `languages`, `preview`, `disabled`, `rpm`, `rpd`,
`tpd`. `exclude` uses `provider:model`. Declared models are required; unknown
candidates are ignored. Provider and candidate `extra` objects merge, with
candidate values taking precedence (nested values replace whole fields).
Gemini `extra` fields merge at the top of its JSON body. JSON usage is an
explicit selection, not a keyword guess or automatic validation: configure its
format through `extra` and/or supply `accepts`.

Images are filtered for every usage, including tool fallback. Vision capability
must be declared on the provider or model; `vision: false` on a model overrides
a provider's capability. With `reserveVision: true`, `visionOnly` models are
kept for images. `local: true` works without credentials and preserves the
existing masking boundary: only external providers receive masked requests.
Ollama uses `/v1/chat/completions`; `createLlamaCppProvider` remains available
for health, loading, streaming and direct llama.cpp calls.

Reservations happen atomically before sending. RPM uses a rolling 60-second
window; RPD/TPD reset on the UTC date. Quotas with no field are unlimited;
zero or a margin-rounded limit of zero forbids calls. Reservations include the
system prompt, transcript, tool schemas and output ceiling; explicit
`estimatedTokens` must already include the full call. Failed calls conservatively
keep their reservation. A 429 or 503 or timeout rests the credential/model;
three consecutive actual failures exclude it for five minutes. A 429 does not
count as an actual failure. Request errors 400/413/414/422 do not penalize health;
404 excludes the model until `reset()`. Caller cancellation stops immediately
and does not mark a failure. `whenAllCooling: 'try'` can retry resting models
when all rest; it never bypasses quotas, exclusion or degradation.

Keys are deduplicated, re-read per request and tried in rotating order, with a
fallback to the next credential. State identifies credentials by ordinal
(`provider:model@key-1`), never by any part of a key. Replacing a credential in
one slot keeps that slot's existing accounting until it expires or is reset.
`keysByUsage` isolates dedicated pools (for example news from chat);
`keyLane(ctx)` identifies custom dynamic pools. Keys default to independent
quotas; set `sharedKeyQuotas: true` when they share one account's model quota.
All instances sharing a store must use the same pool order and state prefix.

`route` rejects empty answers and unknown tool names, keeps partial text as a
last resort, and trims it to whole sentences. If no tool-capable answer is
accepted, it retries the chat/vision list with `tools: []` and keeps the read
transcript. `fallbackWithoutTools: false` disables that retry. Tools are never
executed by the router. An agent can use `runToolLoop({ turn: async request => {
const r = await router.route(request); return { ...r.value, model: r.key }; },
... })`. Business retrieval and source collection remain injected.

Errors have clean codes: `AI_NO_PROVIDER`, `AI_NO_MATCH`, `AI_UNAVAILABLE`,
`AI_STATE_UNAVAILABLE`, `AI_ROUTER_STOPPED`. State outages fail closed instead of
silently losing a distributed quota. Transport messages and credentials are
not included in these errors.

### Gemini Google Search grounding

Set `googleSearch` on a request to enable Gemini's built-in search tool
(`google_search`). OpenAI-format providers ignore it. A `detailed` Gemini
provider then returns `grounding: { searched, queries, sources: [{ title, url }],
searchSuggestionsHtml, functionsDropped }`. With application functions,
`combine` sends both tools, `alone` sends only search for that turn, and `auto`
(default) sends both and retries with search alone when the API rejects the
combination (HTTP 400). Pages are untrusted data: only cleaned single-line
titles and credential-free `http(s)` URLs are returned (at most 20 sources and
10 queries); nothing from a page is ever treated as an instruction.
`readGeminiGrounding(response)` reads a raw generateContent response the same
way.

### Injectable state: memory, Redis, PostgreSQL

```js
const { createMemoryRoutingStore, createRedisRoutingStore,
  createPostgresRoutingStore } = require('@astratra/ai');
const memory = createMemoryRoutingStore();
const redisStore = createRedisRoutingStore({ client: connectedRedis, prefix: 'app:ai:' });
const postgresStore = createPostgresRoutingStore({ pool, table: 'ai_routing_state' });
await postgresStore.initialize(); // explicit table creation, once during setup
const router = createConfiguredRouter({ ...config, store: postgresStore });
```

Memory is local to a process unless you share the same object. Redis uses
optimistic CAS in Lua with a two-day TTL (configurable, at least one day), and
retries contention. PostgreSQL locks even first insertion using a transaction
advisory lock and stores JSONB. Connections and database drivers belong to the
consumer; the package does not connect, install a driver, or close their pool.
A custom Redis/PostgreSQL/other adapter implements:

```ts
interface RoutingStateStore {
  read(key: string): Promise<RoutingState | null>;
  update<T>(key: string, change: (old: RoutingState | null) => {
    state: RoutingState | null; value?: T;
  }): Promise<T | undefined>;
}
```

`update` must serialize each key across processes. The synchronous callback
must be side-effect free and may run multiple times. `state: null` deletes the
key. `read` returns an independent snapshot.

### Environment configuration

`readAiConfigFromEnv({ env: process.env, prefix: 'IA_' })` reads only the supplied
object, never an `.env` file. `ARIA_` or another prefix works identically.

| Variable (default prefix) | Value |
| --- | --- |
| `IA_PROVIDERS` | JSON array of `{ id, format, url, local?, vision?, models, extra?, sharedKeyQuotas?, envName? }` |
| `IA_<ID>_URL`, `IA_<ID>_LOCAL` | Optional provider overrides; local accepts true/false/1/0 |
| `IA_<ID>_KEY`, `IA_<ID>_KEY_2` … | Keys, read at every request; sparse suffixes are supported; ID uppercased with non-alphanumeric characters replaced by `_` (or `envName`) |
| `IA_MODELS_QUICK`, `IA_MODELS_CHAT`, `IA_MODELS_TOOLS`, `IA_MODELS_PILOT`, `IA_MODELS_JSON`, `IA_MODELS_VISION` | JSON arrays of `{ provider, model, extra? }` |
| `IA_INTENT_ROUTING` | JSON object `{ intent: { preferred: ['provider:model'] } }` |
| `IA_QUOTA_MARGIN` | JSON number or object `{ rpm, rpd, tpd }`; defaults .75/.90/.85 |
| `IA_TOKEN_BUFFER` | Number; default 1.2 |
| `IA_WAITED_TIMEOUT_MS`, `IA_BACKGROUND_TIMEOUT_MS` | Defaults 12000/45000 |
| `IA_COOLDOWN_MS`, `IA_DEGRADED_MS`, `IA_MAX_FAILURES` | Defaults 120000/300000/3 |
| `IA_STATE_PREFIX`, `IA_WHEN_ALL_COOLING`, `IA_RESERVE_VISION` | Namespace, skip/try, true/false |
| `IA_MODELS_URL`, `IA_MODELS_TOKEN_FILE` | Optional local model server and its Bearer file |
| `IA_TTS_URL`, `IA_TTS_TOKEN_FILE` | Optional Piper server and Bearer file |
| `IA_LANGUAGE_URL`, `IA_LANGUAGE_TIMEOUT_MS` | Optional fastText server; default timeout 800 |
| `IA_GROQ_WHISPER_URL`, `IA_GROQ_WHISPER_MODELS` | Full endpoint, JSON model IDs; defaults Groq transcription endpoint and turbo/large-v3 |
| `IA_CLOUDFLARE_ACCOUNT_ID`, `IA_CLOUDFLARE_WHISPER_URL` | Account for the default Whisper run URL, or explicit full URL |
| `IA_GEMINI_TTS_ENDPOINT`, `IA_GEMINI_TTS_MODELS`, `IA_GEMINI_TTS_VOICE` | Models base URL, JSON model IDs, voice; defaults Gemini endpoint, gemini-2.5-flash-preview-tts, Aoede |

Voice uses `IA_GROQ_KEY[_N]`, `IA_CLOUDFLARE_KEY[_N]` and
`IA_GEMINI_KEY[_N]`. No provider catalogue is auto-created: `IA_PROVIDERS`
is required to configure text routing. Voice/local sections are returned as
`config.voice`, `config.localModels`, `config.language`. Inject the store in
code after reading the configuration. Invalid JSON is reported by variable
name only, never by its value. Endpoint/model defaults are configurable
protocol examples, not a claim that a model or free tier remains available.

```js
const { readAiConfigFromEnv, createConfiguredRouter } = require('@astratra/ai');
const config = readAiConfigFromEnv({ prefix: 'ARIA_' });
const router = createConfiguredRouter({ ...config, store });
```

## Local models (HTTP protocol)

```js
const { createLocalModelsClient } = require('@astratra/ai');
const models = createLocalModelsClient({
  baseUrl: 'http://127.0.0.1:5007', tokenFile: '/etc/my-app/models-token',
  onError: (error, route) => metrics.count(route, error.code)
});
await models.reclasser('question', ['passage']);             // number[] | null
await models.nli([{ premisse: 'premise', hypothese: 'claim' }]); // comparer alias
await models.entites('Ada', ['person']);                    // UTF-16 spans
const vectors = await models.vecteurs(['text']);            // vectors.modele/dimensions
await models.transcrire(pcm16Base64, { langue: 'fr', vocabulaire: '', timeoutMs: 15000 });
models.disponible('/vecteurs');                             // available alias
```

Without `baseUrl`, each operation returns `null` and availability is false.
Invalid input, malformed results, downtime or deadlines also return `null`;
`onError` receives a clean `AiServiceError` and route. Caller abort throws its
reason. Limits match the source server: 50 passages, 20 NLI pairs, entity text
8000 UTF-16 units, 10 labels of 50 characters, 32 vector texts of 2000 characters,
and PCM16 mono 16kHz for .2–30 seconds, vocabulary 600 characters. Whisper accepts
fr/en/es/ln. Vector results must come from `bge-m3-onnx-int8`, 1024 dimensions
(configurable when the server's embedding space changes); mismatches are refused.

The Bearer file is cached for one minute, including concurrent reads. If a file
is explicitly configured but unreadable, calls fail closed; without a file no
authentication header is sent. The server receives `X-Delai-Ms`. Defaults per
route: rerank 1000ms, NLI/vector 1500ms, entities 800ms, transcription 15000ms.
Each route has its own three-failure/60-second circuit, with one recovery probe;
4xx refusals do not open it. Python engines, ONNX runtimes and weights are not
bundled or downloaded by this client. A generic in-process embedding
and native voice primitives remain in `@astratra/rag` and `@astratra/voice`.

## Transcription, speech and language

```js
const { readAiConfigFromEnv, createTranscriptionService,
  createSpeechService, createServiceLanguageDetector } = require('@astratra/ai');
const config = readAiConfigFromEnv({ prefix: 'IA_' });
const transcription = createTranscriptionService({ ...config.voice, localModels: config.localModels });
const heard = await transcription.transcribe({
  audio: pcm16Bytes, format: 'pcm16', language: 'fr', vocabulary: '', signal,
  allowRemote: false // optional: confidential calls remain on this machine
});
const speech = createSpeechService(config.voice);
const spoken = await speech.synthesize({ text: '**Hello**', language: 'en', signal });
// { audio: Buffer, format: 'wav', mimeType: 'audio/wav', sampleRate, channels,
//   provider: 'piper' | 'gemini', model, fallback }
const language = createServiceLanguageDetector(config.language);
await language.reply('hello', 'fr'); // fastText first, then small-word heuristic
```

Transcription tries local Whisper, then Groq (multipart with a WAV file for PCM),
then Cloudflare (raw file base64 in `{ audio }`, including `success:false` checks).
`format: 'pcm16'` is little-endian 16kHz mono; `'wav'` can use the local server
when it contains that same PCM format. `'file'` forwards compressed audio to
remote services; this client does not transcode it. Base64 or byte input works.
Local silence is a valid empty transcription and stops the chain. Low logprob,
stock subtitle hallucinations or repeated words are rejected; `stockPhrases`,
`noSpeechThreshold`, `logprobThreshold` are configurable. Remote language remains
`null` if the service did not identify it. Limits, timeouts, key rotation and
rests are enforced, and an aborted request never proceeds to the next provider.

Speech tries Gemini TTS first (online, rotating keys/models), then Piper `/tts`
(`{ text, lang }` → validated WAV) as the local fallback. `order: ['piper', 'gemini']`
reverses it; `allowRemote: false` keeps everything local. Gemini PCM is wrapped in a WAV header with the supplied
sample rate (24kHz by default), never mislabeled as an existing WAV file.
`speakableText` removes markup/emoji and limits text to 6000 characters;
`prepareText` can provide your app's pronunciation rules. A missing Piper
language rests only that language. Local timeout is 30s, Gemini timeout 45s;
keys/models rest for 120s after failure, configurable per provider. A whole
synthesis uses one provider. Native segmentation, prosody, AAC finishing and
voice caching are separate existing `@astratra/voice` primitives.

`AI_TRANSCRIPTION_UNAVAILABLE` and `AI_SPEECH_UNAVAILABLE` identify exhausted
chains; input errors use `AI_AUDIO_INPUT`/`AI_SPEECH_INPUT`. Unconfigured optional
services never initiate an implicit local request. Language supports fr/en/es
by default; custom word lists can extend it. Statistical confidence defaults to
0.5, or 0.9 for fewer than three words; unsupported/uncertain results keep the
app language or a clear heuristic result.

## Native tool risk and confirmation

```js
validateNativeTools(tools, { requireSummary: true, requireRisk: true });
const ledger = createSourceLedger();
const exposure = { untrusted: false };
const callTool = createToolCaller({
  tools, context: { userId }, timeoutMs: 20000, signal,
  confirmationPolicy: { threshold: 'MEDIUM' }, exposure,
  readsUntrusted: (tool, result) => tool.name === 'read_shared_page'
    || result?.sources?.some((source) => source.kind === 'web'),
  keep: ledger.keep,
  record: async ({ tool, args, found }) => saveAction(tool.kind, args, found)
});
await runToolLoop({ system, messages, tools: toolSpecs(tools), turn, callTool,
  maxTurns: 6, maxMs: 60000, signal,
  finalInstruction: 'Answer now with what you have read: no more tools.' });
ledger.sources(); ledger.evidence();
```

All new options are opt-in. `requireRisk` enforces LOW/MEDIUM/HIGH, LOW-only
standalone writes, and undo for LOW confirmation tools. Under a confirmation
policy, a `confirm` tool runs its preparation; MEDIUM/HIGH (or UNKNOWN),
untrusted exposure or a result's `confirm: true` wait and never run `perform`.
A LOW tool below the threshold can perform immediately, only with an undo
handler; `record` then receives its effective `kind: 'write'` and undo data.
The preparation must be read-only. Without a policy, the original behavior
remains: all `confirm` tools prepare and wait. `toolRiskOf` and
`waitsForToolConfirmation` expose the same decisions. Unknown risk always waits,
even under `'never'`; untrusted exposure also forces waiting.

`readsUntrusted` is application policy, not a fixed list of business tools. All
calls share `exposure`; subsequent tools see the reads already completed.
Tools in a parallel batch are concurrent: do not schedule a write alongside
an untrusted read when its decision depends on that read. Tool handlers must
honor their injected AbortSignal; timed-out preparation cannot subsequently
start `perform`. Existing source ledger, legacy registry risk policy/pending
actions, and loop budgets are reused. Loop `maxMs` is checked between turns;
model and tool deadlines bound individual operations, and the final no-tool
turn remains allowed after the budget boundary.

### Verification commands

```sh
cd packages/ai
npm test -- --runInBand
node scripts/verify-mutations.cjs
cd ../..
npm run typecheck
```

HTTP contract tests start only loopback servers. If the execution environment
forbids sockets, `AI_TEST_TRANSPORT=memory` explicitly uses simulated HTTP
responses for the new suites. That mode proves behavior and serialization,
not actual socket transport; the existing socket suites still require loopback
permission. No test makes a remote provider call.

Local configured providers also accept `maxConcurrent` (default 8) and
`maxQueue` (default 20): inference is bounded and queued cancellation consumes
no quota. The queue wait is bounded by the model deadline. `Retry-After`
(seconds or HTTP date) takes precedence over the configured 429/503 rest;
`cooldownJitterMs` (environment: `IA_COOLDOWN_JITTER_MS`, default 0) adds optional
jitter only when no provider delay was announced. `readRetryAfter` and
`createInferenceQueue` are available separately.

The local client also exposes English adapters: `rerank`/`embed` are aliases;
`compare` maps `{ premise, hypothesis }` to `{ entailment, neutral,
contradiction }`; `entities` maps UTF-16 spans to `{ text, type, start, end,
score }`. They connect directly to existing package primitives:

```js
await rerankResults(query, found, { score: models.rerank });
await findContradiction(answer, excerpts, { compare: models.compare });
const masker = createReversibleMasker({
  detect: (text) => models.entities(text, ['person'])
});
```
