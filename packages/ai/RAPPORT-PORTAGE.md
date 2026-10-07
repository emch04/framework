# Portage Oracle et Tertius dans @astratra/ai — 8 octobre 2026

Les ajouts demandés sont implémentés, typés et documentés. La validation sur de
vrais serveurs HTTP locaux reste bloquée par le bac à sable : `listen EPERM:
operation not permitted 127.0.0.1`. Elle n'est pas présentée comme réussie.
Aucune application consommatrice ni aucun projet source n'a été modifié.

## API ajoutée

| Fonction | Contrat |
| --- | --- |
| `createConfiguredRouter(config)` | `route(request|string, options?, context?)` renvoie `{ value: {text, toolCalls, cut}, provider, model, key, stateKey, usage, complexity, partial, fallback }`. `ask` rend seulement `value`. `getStats` et `reset` sont asynchrones ; `stop` ferme ce routeur sans fermer les connexions du consommateur. |
| `estimateRequestComplexity`, `estimateRequestTokens` | Complexité simple/medium/complex ; estimation conservatrice du système, historique, schémas d'outils et plafond de sortie. `estimatedTokens` explicite permet le comptage du consommateur. |
| `createMemoryRoutingStore`, `createRedisRoutingStore`, `createPostgresRoutingStore` | État atomique injectable, API `read(key)` / `update(key, callback)`. Redis : CAS Lua avec reprises de contention. PostgreSQL : transaction, verrou avant même la première insertion et JSONB ; création de table explicite par `initialize`. Connexions injectées, aucune dépendance installée. |
| `readAiConfigFromEnv`, `readEnvironmentKeys` | Lecture d'un objet d'environnement avec préfixe paramétrable, clés multiples relues à chaque demande, sans ouvrir de fichier `.env`. |
| `createLocalModelsClient` | `reclasser`/`rerank`, `nli`/`comparer`, `compare` en schéma anglais, `entites`/`entities`, `vecteurs`/`embed`, `transcrire`, `disponible`/`available`. Les cinq contrats HTTP Scolaris sont conservés. Sans serveur configuré : `null`, disponibilité fausse. |
| `createTranscriptionService` | `.transcribe({audio, format, language, vocabulary, signal, allowRemote})` : Whisper local, puis Groq, puis Cloudflare ; résultat avec texte, langue, fournisseur, modèle, repli et confiance locale. |
| `createSpeechService` | `.synthesize({text, language, signal, allowRemote})` : Piper puis Gemini ; Buffer WAV validé, fréquence, canaux, fournisseur, modèle et indicateur de repli. |
| `createServiceLanguageDetector` | `.reply(text, appLanguage)` : serveur fastText, puis heuristique de mots ; langue de l'application si incertain. |
| `toolRiskOf`, `waitsForToolConfirmation` | Décision LOW/MEDIUM/HIGH/UNKNOWN, seuil explicite, protection après lecture non fiable. |
| `createInferenceQueue`, `readRetryAfter` | File locale bornée, annulation des attentes sans quota consommé ; lecture des secondes ou dates HTTP annoncées par le fournisseur. |
| Utilitaires vocaux/HTTP | `pcmToWav`, `readPcmWav`, `speakableText`, `doubtfulTranscription`, `createTokenFileReader`, `serviceRequest`, `AiServiceError`. |

Les fonctions existantes restent disponibles. Les options de confirmation native
et la validation stricte du risque sont opt-in. Les anciens résultats d'outils
et l'objet `context.exposure` utilisé par Tertius sont conservés et testés.
Les adaptateurs Gemini acceptent désormais leurs `extra` ; les erreurs des deux
adaptateurs transmettent le `Retry-After` sans secret.

## Reprise, fichier source par fichier source

| Source lue | Repris dans le framework | Ce qui reste volontairement hors de cette reprise |
| --- | --- | --- |
| Oracle `provider.manager.js`, 2045 lignes | Usages/intention, complexité, ordre configurable des fournisseurs, RPM glissant/RPD/TPD, marges .75/.90/.85, réserve ×1.2, rotation des clés et voies dédiées, 429/503/délais, Retry-After, jitter configurable, 3 échecs/5 minutes, 404, limites de contexte, vision, file d'inférence locale bornée. | Catalogues et quotas historiquement mesurés, règles scolaires, journaux applicatifs, grounding Google et orchestration de streaming Oracle. Le routeur utilise les adaptateurs HTTP du framework ; la reprise temporisée Groq propre à son agent n'est pas copiée, les candidats/clés suivants sont essayés. |
| Oracle `model.policy.js`, 27 lignes | Politique explicite par modèles déclarés, `disabled`, `preview`, `exclude`, capacités et contexte. | Identifiants retirés et remplacement Groq figé : ils appartiennent au catalogue du consommateur ; aucun modèle choisi silencieusement par le framework. |
| Oracle `groq.service.js`, 198 lignes | Adaptateur OpenAI existant, clés dynamiques, nettoyage du raisonnement, extras et bascule. | Prompts scolaires et reconstruction/troncature spécifique de l'ancien historique XML ; le consommateur fournit sa transcription et ses limites de contexte. |
| Oracle `mistral.service.js`, 170 lignes | Adaptateur OpenAI, absence de clé, quotas et capacités configurés, repli. | Catalogue mort des paliers gratuits/payants et prompts Oracle. |
| Oracle `gemini.service.js`, 189 lignes | Adaptateur Gemini/Gemma existant, clés multiples relues, états par modèle/clé, quotas, repos, extras, images et résultats d'outils. | SDK Google et grounding du produit ; aucune dépendance SDK ajoutée. |
| Oracle `vercel.service.js`, 95 lignes | Gateway OpenAI configurable, options par modèle, clés dynamiques et place configurable dans le repli. | Catalogue commercial et journaux du produit. |
| Oracle `ollama.service.js`, 231 lignes | LLM local facultatif sans clé, frontière de masquage, file locale bornée ; Ollama `/v1/chat/completions` et client llama.cpp déjà présent. | Parseur NDJSON et prompts Oracle remplacés par le contrat OpenAI commun ; aucune copie du serveur d'inférence. |
| Oracle `modeles.client.js`, 216 lignes | Cinq routes, limites d'entrée, réponses validées, Bearer fichier relu en cache, délai transmis, disjoncteur séparé par route et une seule sonde. | Chemins `/etc/scolaris` et adresse implicite retirés : configuration requise. Un fichier Bearer explicitement configuré mais absent ferme l'accès, au lieu d'envoyer sans authentification. |
| Oracle `modeles_server.py`, 707 lignes | Contrats `/reclasser`, `/nli`, `/entites`, `/vecteurs`, `/transcrire`, positions UTF-16, espace des vecteurs, limites PCM16 et confiance. | Moteurs Python/ONNX/GLiNER/faster-whisper et poids restent dans le serveur existant, conformément à la demande de client HTTP JavaScript. |
| Oracle `tts_server.py`, 194 lignes | `/tts` reçoit `{text, lang}`, retourne un WAV vérifié ; repos séparé par langue. | Installation, chargement des voix et moteur Piper restent dans ce serveur. |
| Oracle `langdetect_server.py`, 118 lignes | `/detect` reçoit `{text}`, résultat `{lang, confidence}`, délai et repli heuristique. | Moteur fastText et poids restent dans le serveur. |
| Tertius `ai/assistant.js`, 225 lignes | Listes quick/chat/tools-pilot/json/vision, extras, filtrage vision pour chaque usage, repos 429/503/délai, 12 s/45 s, acceptation d'outils connus, texte partiel ramené aux phrases entières et repli sans outils. | TEXT/QUICK/PILOT datés sont la configuration du consommateur, aucune promesse sur un palier gratuit ou un modèle toujours disponible. |
| Tertius `ai/transcription.js`, 126 lignes | Whisper local via serveur, vocabulaire injectable, confiance/silence, détection de phrases inventées et répétitions ; repli Groq/Cloudflare demandé. | Téléchargement/chargement sherpa-onnx et segmentation du microphone déjà dans `@astratra/voice` ; vocabulaire biblique spécifique non copié. |
| Tertius `ai/speech.js`, 118 lignes | Gemini TTS, voix configurable (Aoede par défaut), rotation et repos par clé/modèle, PCM correctement enveloppé en WAV. | Ordre cloud-first remplacé par l'ordre Piper → Gemini explicitement demandé ; Voxtral, échantillon de clonage vocal et lecture par morceaux ne font pas partie de cette chaîne. |
| Tertius `ai/voice.js`, 244 lignes | Nettoyage pour la voix, absence de markup/emoji, borne de texte, cohérence WAV et fournisseur identifiable. | Prosodie, références bibliques, chiffres prononcés, cache disque, Piper résident et finition FFmpeg/AAC sont des règles produit ou des primitives déjà dans `@astratra/voice`. |
| Tertius `ai/language.js`, 61 lignes | Mots fr/en, extension es, confiance minimale et plus forte sur les messages courts, repli sur langue de l'application. | Chargement WASM remplacé par le serveur fastText configurable demandé. |
| Tertius `rag/rerank.js`, 153 lignes | Reclassement facultatif, scores validés, repli sur ordre original ; le client local se branche sur `rerankResults` existant. | Tokenisation et moteur ONNX restent côté serveur ; activation/mesures de la bibliothèque Tertius restent au consommateur. |
| Tertius `rag/model.js`, 61 lignes | Client de vecteurs facultatif, validation de dimension/modèle et espace explicite ; `embed` disponible. | Chargeur e5 local déjà fourni par `@astratra/rag`, indexation et préfixes propres à la bibliothèque non dupliqués. Le serveur Scolaris garde son espace bge-m3 distinct. |
| Tertius `agent/loop.js`, 145 lignes | Boucle native déjà présente, tours/temps/outil bornés, dernier tour sans outils, sources collectées ; repli de routage sans outils ajouté. | Identité, mémoire personnelle, recherche et outils bibliques/scolaires restent injectés par l'application. |
| Tertius `agent/registry.js`, 67 lignes | `requireRisk` opt-in, LOW/MEDIUM/HIGH, écritures automatiques LOW seulement, undo obligatoire pour confirmations LOW. | Chargement des fichiers d'outils métier et libellés d'interface restent au consommateur. |
| Tertius `agent/toolCall.js`, 134 lignes | Seuil de confirmation, UNKNOWN en attente, LOW automatique avec undo, exposition non fiable partagée, préparation annulée ne déclenchant pas d'écriture tardive. | Tables SQL, cartes personnelles et listes de sources/outils non fiables restent des callbacks du produit. |

Il n'existe pas de `cloudflare.service.js` dans le chemin Oracle fourni. Son
implémentation Whisper est dans `provider.manager.js` : le corps base64 nu et
le refus `success:false` sont repris. Le chat Cloudflare utilise l'adaptateur
OpenAI configurable, avec URL de compte fournie par le consommateur.

## Fichiers du paquet

- Nouveaux modules : `managedRouter.js`, `routingState.js`, `aiConfig.js`,
  `localModels.js`, `serviceHttp.js`, `serviceLanguage.js`, `voice.js`,
  `providerLimits.js`.
- Adaptateurs complétés : `gemini.js`, `openaiCompatible.js`, `modelAnswers.js`.
- Agent natif complété : `nativeTools.js`. Les modules existants `agentLoop.js`,
  `toolRegistry.js`, `sources.js`, `breakers.js`, `fallback.js`, `llamaCpp.js`
  sont réutilisés sans changement de leurs API.
- Exports/types/exemples : `index.js`, `index.d.ts`, `typecheck.ts`, `README.md`.
- Six nouvelles suites, fixture HTTP/simulation et lanceur de trois mutations.
  Les fixtures existantes de llama.cpp et SSE font désormais remonter
  immédiatement une erreur de `listen`, sans attendre artificiellement 5 s.
- Inventaire : `PORTAGE.md`. Preuves : `VALIDATION-RESULTS.json`,
  `MUTATION-RESULTS.json`, ce rapport.
- Seul fichier extérieur modifié : entrée en tête de `CHANGELOG.md`.

## Configuration d'environnement

Préfixe `IA_` par défaut, `ARIA_` ou autre via `readAiConfigFromEnv({prefix})`.

- `PROVIDERS` : tableau JSON des fournisseurs, formats, URLs, capacités,
  modèles, quotas et extras. Aucun catalogue automatique.
- `<ID>_KEY`, `<ID>_KEY_2`… : rotation, doublons éliminés, suffixes troués
  acceptés ; `<ID>_URL` et `<ID>_LOCAL` surchargent le fournisseur.
- `MODELS_QUICK`, `MODELS_CHAT`, `MODELS_TOOLS`/`MODELS_PILOT`, `MODELS_JSON`,
  `MODELS_VISION` : listes JSON de candidats par usage.
- `INTENT_ROUTING`, `QUOTA_MARGIN`, `TOKEN_BUFFER`, `STATE_PREFIX`,
  `COOLDOWN_MS`, `COOLDOWN_JITTER_MS`, `DEGRADED_MS`, `MAX_FAILURES`,
  `WAITED_TIMEOUT_MS`, `BACKGROUND_TIMEOUT_MS`, `WHEN_ALL_COOLING`,
  `RESERVE_VISION` : routage et état.
- `MODELS_URL`, `MODELS_TOKEN_FILE`, `TTS_URL`, `TTS_TOKEN_FILE`,
  `LANGUAGE_URL`, `LANGUAGE_TIMEOUT_MS` : services locaux.
- `GROQ_WHISPER_URL`, `GROQ_WHISPER_MODELS`, `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_WHISPER_URL`, `GEMINI_TTS_ENDPOINT`, `GEMINI_TTS_MODELS`,
  `GEMINI_TTS_VOICE` : voix ; clés `<GROQ|CLOUDFLARE|GEMINI>_KEY[_N]`.

Toutes ces variables portent le préfixe choisi. L'état mémoire, Redis ou
PostgreSQL est injecté en code. Le README contient le tableau complet, les
valeurs par défaut et les exemples CommonJS. Ses nouvelles sections et les
nouveaux commentaires sont en anglais ; le README préexistant était français.

## Taille et couverture

- Sources demandées : **5524 lignes**, 21 fichiers présents, hors helper
  `prompts.js` et hors service Cloudflare absent.
- Paquet avant : **4492 lignes** de JavaScript/déclarations, dont 3673 JS et
  819 types ; **284 tests** sur 20 suites.
- Ajouts de runtime : **810 lignes** dans 8 modules, plus extensions ciblées.
  Paquet après : **5644 lignes**, dont 4541 JS et 1103 types.
- Six nouvelles suites : **754 lignes**, **83 cas supplémentaires**.
  Total : **367 tests**, 26 suites.

L'écart entre 5524 lignes sources et les seuls nouveaux modules est expliqué
fichier par fichier ci-dessus : les moteurs de plus de 1000 lignes restent des
services, les catalogues et règles métier ne sont pas universels, et une partie
substantielle de Tertius importait déjà Astratra. Les comportements demandés sont
exercés par module ; il ne s'agit pas d'une copie ligne pour ligne des produits.

## Résultats exacts

| Vérification | Résultat |
| --- | --- |
| `npm test -- --runInBand` dans le paquet, transport HTTP réel | **21 suites réussies, 5 échouées ; 287 tests réussis, 80 échoués, 0 ignoré ; sortie 1**. Tous les échecs portent `EPERM` à l'ouverture de `127.0.0.1`. |
| `AI_TEST_TRANSPORT=memory npm test -- --runInBand --testPathIgnorePatterns='llamaCpp.test.js|eventStream.test.js'` | **24 suites réussies ; 348 tests réussis, 0 échoué, 0 ignoré ; sortie 0**. Les 19 tests des deux suites socket existantes sont exclus de cette commande, pas validés par simulation. |
| Nouveaux tests en simulation | **83/83 réussis** ; les 66 contrats HTTP nouveaux sont simulés explicitement, les 17 autres cas sont sans socket. |
| Mutations | **3/3 détectées**, fichiers remis à leur contenu d'avant chaque mutation. |
| `npm run typecheck` à la racine, après le test HTTP complet | **Sortie 0**, aucun diagnostic. |
| ESLint ciblé sur les modules et tests concernés | **Sortie 0**, aucune erreur ni avertissement. |
| `git diff --check` | **Sortie 0**. |

Répartition des échecs réels bloqués : `llamaCpp.test.js` 11,
`eventStream.test.js` 3, `configuredRouter.test.js` 36,
`voiceServices.test.js` 15, `localModels.test.js` 15.

Mutations constatées :

1. Suppression du refus après réservation de quota :
   `enforces rpm margins and shares atomic reservations between routers` échoue,
   sortie 1 ; fichier restauré.
2. Acceptation d'un autre modèle de vecteurs :
   `rejects malformed /vecteurs response` échoue, sortie 1 ; fichier restauré.
3. Contournement du seuil HIGH :
   `HIGH confirmation waits; run prepares but perform never executes` échoue,
   sortie 1 ; fichier restauré.

## Reste et version

**Reste réel :** relancer `npm test` dans un environnement autorisant les ports
locaux. Les serveurs réels et les 80 cas concernés ne sont pas validés ici.
Les adaptateurs Redis/PostgreSQL ont leurs tests de contrat/CAS/transaction,
mais aucun serveur de base de données réel n'a été lancé. Aucun fournisseur
externe ni moteur Python/ONNX réel n'a été interrogé, conformément à l'interdiction
de réseau et d'installation. L'intégration de Centrale LJ, Muzika, Scolaris et
Tertius demande leurs propres modifications, hors du périmètre autorisé.

Version recommandée pour ces ajouts rétrocompatibles : **1.7.0**, après cette
validation HTTP. `package.json` reste à **1.6.0**. Aucun commit, push,
publication, déploiement, installation npm ni lecture de fichier `.env`.
