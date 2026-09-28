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
npm test                 # client, disjoncteur, générateurs, contrat client <-> app.py (python3 requis pour ce dernier)
npm run test:server      # service Python avec moteurs factices
npm run check:setup      # bash -n et épinglages du script d'installation
```
