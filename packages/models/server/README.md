# Service de modèles local (processeur, sans GPU)

`app.py` sert cinq petits modèles gardés en mémoire derrière une API HTTP
locale. Pensé pour un VPS sans carte graphique : tout tourne sur le
processeur (ONNX int8, CTranslate2 int8, torch CPU).

| Point d'entrée | Modèle testé | Entrée → sortie |
|---|---|---|
| `POST /embed` | bge-m3 ONNX int8 | `{texts}` → `{vectors, model, dimensions}` |
| `POST /rerank` | gte-multilingual-reranker ONNX int8 | `{query, documents}` → `{scores, model}` |
| `POST /nli` | mDeBERTa XNLI ONNX int8 | `{pairs: [{premise, hypothesis}]}` → `{results: [{entailment, neutral, contradiction}], model}` |
| `POST /entities` | GLiNER multi v2.1 | `{text, labels?}` → `{entities: [{text, label, start, end, score}], model}` |
| `POST /transcribe` | faster-whisper (base) int8 | `{audio, language?, prompt?, vad?}` → `{text, language, avg_logprob, no_speech_prob, duration_ms, audio_ms, model}` |
| `GET /health` | — | `{status, version, models: {nom: {configured, loaded, failed, model}}}` |
| `GET /livez` | — | `{status: "ok"}`, sans jeton (sonde de vie) |

`audio` : PCM 16 bits little-endian, mono, 16 kHz, en base64 ; de 0,2 à 30 s
par défaut. `language` : code ISO (`fr`, `en`…), `"auto"` ou absent pour la
détection. `prompt` : vocabulaire attendu (noms propres, termes du produit),
qui améliore nettement la reconnaissance des noms.

## Garanties

- **Chaque modèle est facultatif.** Un modèle absent de la configuration
  répond `503 model_not_configured` ; un modèle qui échoue au chargement
  répond `503 model_unavailable` (échec définitif jusqu'au redémarrage :
  réessayer un modèle cassé à chaque requête coûterait un chargement à
  chaque fois). Les autres continuent de répondre.
- **Chargement paresseux**, ou préchargement au démarrage (`preload`, par
  défaut) avec un appel de chauffe par modèle.
- **Un verrou par modèle** ; une requête qui attend plus de `queue_timeout_s`
  reçoit `503 busy` au lieu d'empiler des fils sans fin.
- **Mémoire** : `max_rss_mb` refuse de charger un modèle de plus au-delà du
  seuil (`503 memory_limit`) ; `idle_unload_s` décharge un modèle inutilisé
  (rechargé au prochain appel). La limite dure se pose au niveau du
  processus : `max_memory_restart` de pm2 ou `MemoryMax=` de systemd (voir les
  générateurs du paquet). `RLIMIT_AS` n'est volontairement pas utilisé :
  onnxruntime et torch réservent beaucoup d'espace virtuel et le processus
  tomberait sans avoir consommé la mémoire.
- **Jeton interne** : `Authorization: Bearer <jeton>` ou `X-Models-Token`,
  comparé en temps constant, vérifié avant de lire le corps. Sans jeton, le
  service refuse de démarrer sur une adresse autre que la boucle locale.
  Sur une machine partagée, mettez un jeton même en `127.0.0.1` : tout
  utilisateur local peut joindre le port.
- **Limites de requête** : taille lue dans l'en-tête avant le corps (`413`),
  corps sans `Content-Length` refusé (`411`), délai de socket
  (`socket_timeout_s`), nombre et longueur des textes bornés (`400`).
- **Rien n'est journalisé du contenu** : seulement route, statut, nombres,
  octets, durées, et le type d'une exception.
- **Hors ligne** : `HF_HUB_OFFLINE=1`, rien n'est téléchargé à l'exécution.

## Erreurs

`{"error": {"code": "...", "message": "..."}}`. Codes : `unauthorized` (401),
`not_found` (404), `method_not_allowed` (405), `length_required` (411),
`payload_too_large` (413), `body_required`, `invalid_json`, `invalid_input`
(400), `model_not_configured`, `model_unavailable`, `busy`, `memory_limit`
(503), `internal_error` (500).

## Configuration

Ordre : valeurs par défaut < fichier JSON nommé par `MODELS_CONFIG` <
variables d'environnement. Une clé inconnue dans le fichier est une erreur.

| Variable | Défaut | Rôle |
|---|---|---|
| `MODELS_HOST` | `127.0.0.1` | adresse d'écoute |
| `MODELS_PORT` | `5007` | port |
| `MODELS_TOKEN_FILE` / `MODELS_TOKEN` | — | jeton interne (16 caractères au moins) ; préférez le fichier |
| `MODELS_DIR` | — | dossier des modèles ; chaque modèle y est cherché sous son nom par défaut |
| `MODELS_ENABLED` | les cinq | ex. `embed,rerank` |
| `MODELS_THREADS` | `2` | fils par modèle (sauf réglage propre) |
| `MODELS_PRELOAD` | `true` | charger et chauffer au démarrage |
| `MODELS_MAX_BODY_BYTES` | `262144` | corps maximal (la transcription calcule le sien) |
| `MODELS_SOCKET_TIMEOUT_S`, `MODELS_QUEUE_TIMEOUT_S` | `30` | délais |
| `MODELS_MAX_RSS_MB`, `MODELS_IDLE_UNLOAD_S` | `0` (désactivé) | mémoire |
| `MODELS_LEGACY_ROUTES` | `false` | routes françaises historiques, voir plus bas |

Chaque réglage d'un modèle se donne par `MODELS_<MODELE>_<CLE>` :
`MODELS_EMBED_PATH`, `MODELS_EMBED_MAX_BATCH`, `MODELS_TRANSCRIBE_MAX_SECONDS`,
`MODELS_TRANSCRIBE_LANGUAGES=fr,en`, `MODELS_ENTITIES_LABEL_MAP={"personne":"person"}`…

| Modèle | Dossier par défaut | Clés |
|---|---|---|
| `embed` | `bge-m3-onnx-int8` | `path`, `id`, `threads`, `max_batch` 32, `max_chars` 2000, `max_tokens` 512, `batch_size` 1 |
| `rerank` | `gte-reranker-onnx-int8` | `path`, `id`, `threads`, `max_batch` 50, `max_chars` 2000 (coupé, pas refusé), `max_tokens`, `batch_size` 16 |
| `nli` | `mdeberta-xnli-multilingual` | `path`, `id`, `threads`, `max_batch` 20, `max_chars` 2000 (coupé), `max_tokens` |
| `entities` | `gliner-multi-v2.1` | `path`, `id`, `threads`, `max_chars` 8000, `max_labels` 10, `max_label_chars` 50, `threshold` 0.5, `chunk_chars` 1500, `batch_size` 1, `default_labels` `["person"]`, `label_map`, `encoder_dir` `_dependances` |
| `transcribe` | `faster-whisper-base` | `path`, `id`, `threads` 4, `min_seconds` 0.2, `max_seconds` 30, `max_prompt_chars` 600, `languages` (null = tout code ISO), `auto_languages` (codes laissés à la détection), `vad` false, `allow_vad` true |

`id` vaut par défaut le nom du dossier. Il est rendu avec chaque vecteur :
deux vecteurs d'`id` différents ne se comparent pas.

Réglages mesurés à conserver : `embed.batch_size` à 1 (le modèle int8 est
quantifié dynamiquement, un même texte seul ou à côté d'un plus long sortait
à un cosinus de 0,995 de lui-même) ; `entities.batch_size` à 1 (par six
morceaux, la mémoire montait à 4,8 Go) ; `faster-whisper-base` plutôt que
`small` (0,35 s contre 1,2 s par phrase, pour une reconnaissance un peu
moins bonne).

GLiNER nomme son encodeur dans `gliner_config.json` ; le service le fait
pointer vers la copie locale de `encoder_dir` au travers d'un dossier
temporaire de liens, sans modifier le dossier du modèle.

## Routes historiques (facultatives)

Avec `MODELS_LEGACY_ROUTES=1`, les anciennes routes restent servies pour un
client qui ne serait pas encore migré : `/reclasser` (`question`,
`passages` → `scores`), `/vecteurs` (`textes` → `vecteurs`), `/entites`
(`texte`, `etiquettes` par défaut `["personne"]` → `texte`, `type`, `debut`,
`fin`, `score`), `/nli` avec `paires` (`premisse`, `hypothese` → `resultats`
`accord`, `neutre`, `contradiction`), `/transcrire` (`audio`, `langue` parmi
`fr en es ln` — `ln` laissé à la détection —, `vocabulaire` → `texte`,
`langue`, `logprob`, `sans_parole`, `duree_ms`), et `/health` ajoute
`modeles`. Les erreurs gardent le nouveau format. À désactiver une fois les
clients migrés.

## Installation

```bash
# environnement Python aux versions épinglées (bash 3.2+)
bash server/setup-venv.sh --components onnx,entities,transcribe /srv/models-venv
#   onnx : embed, rerank, nli (sans torch) ; entities : GLiNER (torch CPU) ; transcribe : faster-whisper
bash server/setup-venv.sh --check-only      # vérifie les épinglages, sans réseau

# lancement direct
MODELS_DIR=/srv/models MODELS_TOKEN_FILE=/etc/models/token /srv/models-venv/bin/python server/app.py
```

Les poids des modèles ne sont pas dans le paquet : posez-les dans
`MODELS_DIR` (un dossier par modèle, plus `_dependances/` pour l'encodeur de
GLiNER).

## Tests

```bash
python3 -m unittest discover -s server/tests          # moteurs factices, bibliothèque standard seule
MODELS_SMOKE_DIR=/srv/models [MODELS_SMOKE_AUDIO=voix-16k.wav] \
  /srv/models-venv/bin/python -m unittest discover -s server/tests -p 'test_real_models.py'
```
