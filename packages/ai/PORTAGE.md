# Oracle and Tertius portability inventory

Scope: packages/ai, plus the authorized root changelog entry. Source projects
remain read-only. No dependencies, model downloads, secrets or environment files.

| Source file | Required behavior | Destination / verification |
| --- | --- | --- |
| Oracle provider.manager.js (2045 lines), prompts.js complexity helper | complexity, intent, ordered fallback, model quotas/margins, atomic reservation, rests, failure exclusion, context/vision limits | managedRouter.js, routingState.js, aiConfig.js; local HTTP routing tests |
| Oracle model.policy.js (27) | explicit model policy and excluded/retired models | disabled/preview/exclude model configuration; no silent model substitution |
| Oracle groq.service.js (198), mistral.service.js (170), vercel.service.js (95) | OpenAI HTTP, missing keys, options and fallback | existing openaiCompatible.js plus configured providers |
| Oracle gemini.service.js (189) | multiple keys, per-model rests, dynamic keys | managedRouter.js, aiConfig.js; existing gemini.js extended for extras/local capability |
| Oracle ollama.service.js (231) | optional local LLM | OpenAI /v1 configuration; existing llamaCpp.js |
| Oracle Cloudflare implementation in provider.manager.js (no cloudflare.service.js exists) | chat and raw base64 Whisper envelope, success:false | OpenAI configuration, voice.js |
| Oracle modeles.client.js (216) | five endpoints, validation, optional availability, Bearer file cache, independent route circuits and single probes | localModels.js, serviceHttp.js |
| Oracle modeles_server.py (707) | exact payloads, limits, UTF-16 positions, vector space, PCM16 | localModels.js; five-route HTTP contract tests |
| Oracle tts_server.py (194) | /tts {text, lang} -> WAV | voice.js |
| Oracle langdetect_server.py (118) | /detect {text} -> {lang, confidence} | serviceLanguage.js |
| Tertius ai/assistant.js (225) | quick/chat/pilot/json/vision lists, extras, vision, 12s/45s, partial answers, no-tool retry | managedRouter.js |
| Tertius ai/transcription.js (126) | local Whisper, silence/confidence/hallucination checks | voice.js; model execution/segmentation already belongs to @astratra/voice |
| Tertius ai/speech.js (118) | Gemini TTS keys/models/voice, rests and PCM WAV | voice.js |
| Tertius ai/voice.js (244) | speech cleanup, consistent audio | voice.js; existing plainText; resident Piper/FFmpeg/assembler/cache already in @astratra/voice |
| Tertius ai/language.js (61) | language confidence and word heuristic | serviceLanguage.js with existing language.js |
| Tertius rag/rerank.js (153), rag/model.js (61) | optional ranking/embedding, validated results, vector identity | localModels.js plus existing rerankResults; generic in-process embedder already in @astratra/rag |
| Tertius agent/loop.js (145) | turns/time/tool limits, final turn, source collection, no-tools fallback | existing nativeTools.js, sources.js, agentLoop.js; risk and fallback additions |
| Tertius agent/registry.js (67), agent/toolCall.js (134) | risk validation, threshold confirmations, low-risk undo, untrusted exposure | nativeTools.js opt-in policy, existing pendingActions.js/toolRegistry.js |
| Existing package public API | backwards compatibility, typed exports and documentation | index.js, index.d.ts, typecheck.ts, README.md; full previous suite |
| Root CHANGELOG.md | new entry, proposed minor version only | authorized entry; package.json version unchanged |

Intentional boundaries: school/Bible prompts, personal-memory rules, business tools,
provider model catalogues and historical measured prices/quotas remain consumer
configuration. Python/ONNX engines and weights stay in local servers; no duplicate
native runtime. Live microphone/WebSocket/VAD, Voxtral voice cloning, FFmpeg/AAC
finishing, tone/reference/number pronunciation and disk cache already have their
primitives in @astratra/voice or are product-specific. This addition supplies the
requested local-first HTTP voice chain; Tertius's cloud-first order remains a
consumer choice. Ollama uses its OpenAI endpoint instead of copying NDJSON parsing.
Server deployment/PM2/credentials and migration of the four consuming apps are
outside the authorized writable scope.

The source total is 5524 lines (excluding prompts.js and the absent Cloudflare
service); much is existing Astratra imports, catalogues or model engine code.
Final source/output/test counts and mutation evidence will be recorded after verification.

## Verification outcome

All listed package additions have been implemented. `providerLimits.js` also
carries Oracle's Retry-After handling and bounded local inference queue. English
local-client adapters connect existing reranking/NLI/masking primitives.

Source inventory: 5524 lines. Package before/after: 4492/5644 JS + type lines;
new runtime modules: 810 lines; six new test suites: 754 lines, 83 cases. Existing
284 tests become 367. Three mutations were caught and restored (see
MUTATION-RESULTS.json).

Behavioral simulation: 348 tests / 24 suites pass; the two existing socket
suites (19 cases) are explicitly excluded from that run. Full socket run:
287 pass, 80 fail, all due to listen EPERM on loopback. Root typecheck, targeted
ESLint and diff whitespace checks pass. Actual HTTP transport remains blocked
by environment permissions, not marked verified. Full per-file mapping and
exact commands are in RAPPORT-PORTAGE.md and VALIDATION-RESULTS.json.
