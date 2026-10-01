# @astratra/models

Un service de petits modèles d'IA qui tourne sur le **processeur** d'un VPS
sans carte graphique, et son client Node.

- **Service Python** (`server/app.py`) : vecteurs, reclassement, inférence
  logique (NLI), entités nommées, transcription de la voix. Chaque modèle est
  facultatif, chargé à la demande, derrière un jeton interne, sur
  `127.0.0.1` par défaut. Détails : [server/README.md](server/README.md).
- **Client Node** (CommonJS, aucune dépendance) : `fetch` injecté, délai par
  point d'entrée, relance avec brouillage, disjoncteur par point d'entrée,
  et des résultats qui **ne lèvent jamais** : l'appelant garde son
  comportement d'avant quand le service manque.
- **Catalogue des prix des modèles** : prix d'un appel à un modèle hébergé
  (Groq, Gemini, OpenAI, Anthropic, Vercel AI Gateway, Cloudflare…), fenêtre
  de contexte et capacités, avec des surcharges locales qui priment.
- **Déploiement** : générateurs purs d'une entrée pm2 et d'une unité systemd
  durcie, script d'environnement Python aux versions épinglées.

Les poids des modèles ne sont pas dans le paquet.

## Le client

```js
const { createModelsClient } = require('@astratra/models');

const models = createModelsClient({
  baseUrl: 'http://127.0.0.1:5007',
  token: () => process.env.MODELS_TOKEN, // lu à chaque appel : une clé tournée est prise aussitôt
  embedModel: 'bge-m3-onnx-int8',        // tout autre modèle répond model_mismatch
});

const ranked = await models.rerank(question, passages);
const order = ranked.ok ? byScore(passages, ranked.scores) : passages; // repli : l'ordre d'origine
```

Chaque méthode rend `{ ok: true, ...données }` ou
`{ ok: false, code, endpoint, retryable, status?, message? }`.

| Méthode | Données |
|---|---|
| `embed(texts)` | `vectors`, `model`, `dimensions` |
| `rerank(query, documents)` | `scores` (ordre des documents), `model` |
| `nli(pairs)` | `results: [{ entailment, neutral, contradiction }]`, `model` |
| `entities(text, labels?)` | `entities: [{ text, label, start, end, score }]`, `model` |
| `transcribe(audio, { language, prompt, vad })` | `text`, `language`, `avgLogprob`, `noSpeechProb`, `durationMs`, `audioMs`, `model` |
| `health()` | `version`, `models` (sans disjoncteur) |

`audio` : octets (`Buffer`/`Uint8Array`) ou base64 de PCM 16 bits mono 16 kHz.
Un texte vide est une réponse (du silence), pas une panne : jugez la
confiance avec `noSpeechProb` et `avgLogprob`.

### Codes

`invalid_input` (refusé avant l'appel, ou 400), `payload_too_large`,
`unauthorized`, `not_found`, `model_not_configured`, `model_unavailable`,
`busy`, `memory_limit`, `unavailable`, `server_error`, `timeout`,
`network_error`, `bad_response`, `circuit_open`, `model_mismatch`,
`aborted`.

### Vecteurs : un seul espace

`embed` rend l'`id` du modèle avec les vecteurs. Deux modèles, deux espaces :
comparer leurs vecteurs donne des nombres qui ne veulent rien dire, sans
erreur. Stockez l'`id` avec chaque vecteur, ou fixez `embedModel`.
`asMemoryEmbed()` branche le client sur `@astratra/memory` : il rend
`{ vector, source: id }` et lève en cas d'échec (le souvenir est gardé sans
vecteur, puis réindexé).

### Délais, relances, disjoncteur

- Délais par défaut : embed 1 500 ms, rerank 1 000, nli 1 500, entities 800,
  transcribe 15 000, health 1 000 (`timeouts`, ou `timeoutMs` par appel).
- Relances : 2 essais (1 pour la transcription), recul exponentiel à
  brouillage complet, seulement sur réseau, 5xx et `busy`. Un délai dépassé
  n'est relancé qu'avec `retry.retryTimeouts`.
- Disjoncteur **par point d'entrée** : 3 échecs de suite l'ouvrent 60 s, puis
  une seule sonde. Un reclasseur lent ne coupe pas les entités. Seules les
  pannes comptent : une requête refusée comme invalide est une réponse.
  `createBreaker: (endpoint) => createCircuitBreaker({...})` accepte le
  disjoncteur de `@astratra/resilience` ; `breaker: false` l'enlève.
  `available(endpoint)` dit si un appel partirait maintenant.
- `onEvent` reçoit `retry`, `failure`, `circuit_open`, `breaker` : jamais les
  textes.

## Prix des modèles

```js
const { createPriceCatalog } = require('@astratra/models');

const prices = createPriceCatalog({
  overrides: {
    'groq/openai/gpt-oss-120b': { billing: 'free_tier' },             // gratuit tant que le palier tient
    'gemini-2.5-pro': { pricesPerMillion: { input: 1.0 } },            // prix négocié
    'llama-local': { prices: { input: 0, output: 0 }, contextWindow: { maxInput: 8192 } }
  },
  aliases: { 'oracle-rapide': 'groq/openai/gpt-oss-120b' }
});

const cost = prices.cost('openai/gpt-oss-120b', response.usage, { provider: 'groq' });
if (cost.ok) ledger.record(cost);       // { total, listTotal, billing, breakdown, unitPrices, catalogDate, computedAt, ... }
else log.warn(cost.code, cost.message); // unknown_model | invalid_usage | no_price
```

| Méthode | Rend |
|---|---|
| `lookup(model, { provider })` | `key`, `provider`, `mode`, `prices` (surcharges appliquées), `listPrices` (catalogue), `tiers`, `contextWindow`, `capabilities`, `billing`, `deprecationDate`, `source`, `matchedBy` |
| `cost(model, usage, { provider, freeTierExhausted })` | `total` facturé, `listTotal` (valeur catalogue), `breakdown`, `unitPrices`, `tier`, `usage`, `billing`, `creditPool?`, `catalogDate`, `computedAt` |
| `contextWindow(model)` | `maxInput`, `maxOutput` (`null` si inconnu) |
| `capabilities(model)` | `vision`, `tools`, `toolChoice`, `audioInput`, `audioOutput`, `reasoning`, `promptCaching`, `responseSchema`, `pdfInput`, `webSearch` |

Aucune de ces méthodes ne lève pour un modèle inconnu ou un usage illisible :
`{ ok: false, code: 'unknown_model' | 'invalid_usage' | 'no_price', message }`.
Un champ utilisé sans aucun prix donne `no_price`, jamais un coût nul
silencieux. Seule une surcharge ou un alias invalide lève (`TypeError`), à la
création.

### Retrouver un modèle

Dans l'ordre : identifiant exact (casse ignorée, `models/` de Gemini
retiré) ; alias exact ou par motif (`{ match: /^gpt-4o-\d{4}/, model: 'gpt-4o' }`,
ou une chaîne `(?i)^...` comme le `match_pattern` de Langfuse) ; préfixe de
fournisseur (`openai/gpt-4o` → `gpt-4o`, `google/…` → `gemini/…`,
`vercel/…` → `vercel_ai_gateway/…`) ; enfin suffixe unique chez ce
fournisseur (`gpt-oss-120b` + `groq` → `groq/openai/gpt-oss-120b`).
L'option `provider` limite la recherche à ce fournisseur : le
`openai/gpt-oss-120b` de Groq n'est jamais facturé au prix d'OpenAI, et un
modèle absent chez ce fournisseur rend `unknown_model`.

### Usage

`usage` est soit des comptes **disjoints** (`input`, `output`, `cacheRead`,
`cacheWrite`, `cacheWrite1h`, `audioInput`, `audioOutput`, `reasoning`,
`images`, `seconds`), soit l'objet d'usage brut d'OpenAI (chat ou
Responses), d'Anthropic, de Gemini (`usageMetadata`) ou de l'AI SDK : les
jetons en cache inclus dans le total d'entrée sont retirés avant le calcul
(`normalizeUsage`).

- Cache en lecture et en écriture (5 min et 1 h) à leur prix ; sans prix de
  cache, au prix d'entrée (comme LiteLLM). Audio au prix audio, sinon au prix
  texte ; raisonnement au prix du raisonnement, sinon de la sortie.
- Long contexte (`*_above_200k_tokens`) et `tiered_pricing` : toute la
  requête passe au palier dès que l'invite (entrée + cache + audio) le
  dépasse. Un prix surchargé n'est jamais majoré par un palier du catalogue.

### Surcharges

Objet indexé par identifiant, ou tableau `{ model | match, ... }` (la
première qui correspond gagne). Elles priment toujours sur le catalogue.

| Champ | Effet |
|---|---|
| `prices`, `pricesPerMillion` | prix négociés (USD par jeton, ou par million) |
| `discount` | remise (fraction) sur tous les autres prix du catalogue, paliers compris |
| `billing: 'free'` | facturé 0, `listTotal` garde la valeur catalogue |
| `billing: 'free_tier'` | 0 tant que le palier tient ; `cost(..., { freeTierExhausted: true })` facture au prix |
| `billing: 'credits'` + `creditPool` | montant réel, à débiter du crédit nommé |
| `as` | emprunte l'entrée d'un modèle du catalogue pour un nom local |
| `contextWindow`, `capabilities`, `provider`, `mode`, `note` | complètent ou remplacent le catalogue |

### Coût figé

Chaque coût est un objet gelé qui porte ses prix unitaires, la date du
catalogue et l'heure du calcul : enregistrez-le tel quel. Une mise à jour du
catalogue ou d'une surcharge ne change jamais un coût déjà calculé.

### Provenance et mise à jour

`data/prix-modeles-AAAA-MM-JJ.json` est une copie datée, non modifiée, de
[`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
du projet LiteLLM (BerriAI), sous licence MIT ; rien n'est repris du dossier
`enterprise/` de ce dépôt, qui relève d'une autre licence. Le copyright, la
licence, l'adresse et l'empreinte SHA-256 de la copie sont dans
[data/NOTICE](data/NOTICE). Le chargement prend le fichier daté le plus
récent, une fois par processus.

```bash
npm run prices:update -- --dry-run   # résumé : modèles ajoutés, retirés, prix changés
npm run prices:update                # écrit la copie du jour, retire l'ancienne, réécrit NOTICE
```

Le script ne tourne jamais tout seul : relisez le résumé et lancez les
tests avant de publier.

## Déploiement

```js
const { createPm2App, renderPm2Ecosystem, createSystemdUnit, setupVenvCommand } = require('@astratra/models');

const app = createPm2App({
  python: '/srv/models-venv/bin/python3',
  modelsDir: '/srv/models',
  tokenFile: '/etc/models/token',
  maxMemoryRestart: '5G',
});
fs.writeFileSync('ecosystem.models.js', renderPm2Ecosystem(app));

const unit = createSystemdUnit({
  python: '/srv/models-venv/bin/python3', user: 'models',
  modelsDir: '/srv/models', tokenFile: '/etc/models/token',
  memoryMax: '6G', cpuQuota: '400%',
});
```

- Un seul processus : chaque processus charge sa propre copie des modèles.
- Le jeton n'entre jamais dans un fichier généré : `MODELS_TOKEN` est
  refusé, passez `tokenFile` (systemd le transmet par `LoadCredential`).
- L'unité systemd est durcie (`ProtectSystem=strict`, sans capacités,
  familles d'adresses restreintes) et porte la limite mémoire dure.
- `setupVenvCommand({ venvDir, components })` rend la commande de
  `server/setup-venv.sh`, qui refuse toute dépendance non épinglée ou
  épinglée deux fois différemment, installe torch en roue CPU, puis vérifie
  les versions installées.

## Tests

```bash
npm test                 # client, disjoncteur, générateurs, prix des modèles, contrat client <-> app.py (python3 requis pour ce dernier)
npm run test:server      # service Python avec moteurs factices
npm run check:setup      # bash -n et épinglages du script d'installation
```
