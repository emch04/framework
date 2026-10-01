# Recherche — un agent de code maison sur Astratra

Date du rapport : 28/09/2026
Nature : recherche web uniquement. Aucun fichier de code modifié, aucune clé lue ni affichée, aucun appel d'API avec une clé réelle. Seuls des catalogues **publics et sans authentification** ont été interrogés (`ai-gateway.vercel.sh/v1/models`, `openrouter.ai/api/v1/models`, `integrate.api.nvidia.com/v1/models`, les données embarquées des classements SWE-bench, Terminal-Bench, LiveCodeBench et BFCL).
S'appuie sur, sans la répéter : `~/scolaris/docs/recherche-modeles-ia-2026-09-12.md` (limites Groq, fin du gratuit Cerebras, identifiants Mistral, clauses d'entraînement fournisseur par fournisseur).

Convention :
- **CONFIRMÉ** — lu sur une page officielle du fournisseur ou de l'organisme du classement (ou dans son catalogue d'API public), URL et date de la page citées. Toutes les pages ont été consultées le **28/09/2026**.
- **TIERS** — source tierce (blog, agrégateur, mesure communautaire).
- **SPÉCULATION** — déduction de l'auteur, à valider par exécution.
- « non trouvé » / « non vérifié » — cherché sans résultat fiable. Rien n'est inventé.

---

## 0. Synthèse en dix lignes

1. **Les quotas gratuits ne portent pas un agent de code « lourd ».** Un tour d'agent de code coûte 5 000 à 40 000 jetons d'entrée (préfixe fixe + historique), une tâche moyenne de 25 tours ≈ 600 000 jetons d'entrée. Les tâches difficiles du classement Terminal-Bench 4.0 consomment 20 à 50 **millions** de jetons par essai.
2. **Groq gratuit est inutilisable comme moteur de la boucle** : 8 000 jetons/minute par modèle, donc toute requête au-delà d'environ 8 000 jetons est refusée. Il reste excellent pour les petites tâches annexes (résumer une sortie, rédiger un message, classer une commande).
3. **Gemini gratuit** : les modèles Flash récents sont à ~20 requêtes/jour **par projet** (pas par clé) selon une mesure tierce ; les Flash-Lite à ~500/jour. Sept clés dans un même projet n'apportent rien.
4. **Le levier le plus rentable** : OpenRouter passe de 50 à 1 000 requêtes/jour sur les modèles `:free` après 10 USD d'achats cumulés, et propose `qwen/qwen3.8-27b:free` (262 K de contexte, appel d'outils).
5. **NVIDIA NIM** expose gratuitement en essai `moonshotai/kimi-k3`, `z-ai/glm-5.3` et `deepseek-ai/deepseek-v4.1-flash` (catalogue public vérifié) ; ~40 requêtes/minute d'après les tiers. C'est le meilleur « cerveau » gratuit disponible, à conditions d'usage à vérifier.
6. **Benchmarks** : SWE-bench Verified est abandonné par OpenAI depuis le 23/02/2026 (contamination) et son classement officiel n'a pas bougé depuis le 26/02/2026. Terminal-Bench 2.1 est saturé (tous les fournisseurs annoncent 85-91 %). Le seul classement officiel vivant et discriminant est **Terminal-Bench 4.0** (mis à jour le 21/09/2026) : Gemini 3.8 Flash y fait 19,1 % contre 51,8 % pour Opus 5.
7. Le harnais pèse autant que le modèle : `gpt-oss-120b` fait **26,0 %** sur SWE-bench Verified en bash seul (classement officiel), mais Groq annonce **62,4 %** avec outils.
8. **Conception** : tous les agents qui marchent convergent sur la même architecture — boucle simple, peu d'outils, lecture fenêtrée, remplacement par correspondance exacte, exécution des tests comme juge, bac à sable sans réseau, `.git` protégé, contexte géré activement (compaction, sous-agents).
9. **Astratra a déjà 60 % de la plomberie** (`providerRouter`, `toolRegistry`, `pendingActions`, `resilience`, `memory`, `credentials`). Il manque un paquet d'outils de code, une garde git, un bac à sable, une boucle orientée messages avec appels d'outils natifs, et la gestion du contexte.
10. **Plan** : MVP terminal en lecture/édition/tests avec approbation humaine de chaque écriture, jugé sur 20-30 tâches réelles tirées des dépôts de Kongo, avant toute extension.

---

## 1. Les modèles de code disponibles aujourd'hui, fournisseur par fournisseur

### 1.1 Google Gemini (7 clés, palier gratuit)

**Catalogue — CONFIRMÉ** ([Gemini API, Models](https://ai.google.dev/gemini-api/docs/models), « Last updated 2026-09-24 UTC ») :
- Stables texte : `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`.
- Aperçu : `gemini-3.1-pro-preview`, `gemini-3-flash-preview`.
- Arrêtés : Gemini 2.0 Flash, 2.0 Flash-Lite. Et la page précise : « we are limiting access to the 2.5 models to users who have actively used them in the past ».

**Le plus fort pour le code : `gemini-3.8-flash` — CONFIRMÉ** ([fiche modèle](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), mise à jour « September 2026 ») : entrée 1 048 576 jetons, sortie 65 536, appel de fonctions, exécution de code, cache, sorties structurées, niveaux de réflexion low/medium/high. Présenté pour « long-horizon software engineering, autonomous agents ».

**Palier gratuit et prix — CONFIRMÉ** ([Gemini API, Pricing](https://ai.google.dev/gemini-api/docs/pricing), « Last updated 2026-09-24 UTC ») :

| Modèle | Gratuit | Payant entrée / sortie ($/M) |
|---|---|---|
| `gemini-3.8-flash` | oui | 0,75 / 3,75 (jusqu'au 31/12/2026) |
| `gemini-3.7-flash`, `gemini-3.6-flash` | oui | 0,75 / 3,75 (idem) |
| `gemini-3.5-flash` | oui | 1,50 / 9,00 |
| `gemini-3.5-flash-lite` | oui | 0,30 / 2,50 |
| `gemini-3.1-pro-preview` | **non** | 2,00 / 12,00 (≤ 200 K) |

Au 01/01/2027, les 3.7/3.8 Flash passent à 1,50 / 7,50 $/M — CONFIRMÉ ([blog Google, Introducing Gemini 3.8 Flash](https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/), 02/09/2026).

**Limites de débit** :
- CONFIRMÉ : Google ne publie plus les chiffres par modèle (« can be viewed in Google AI Studio ») et « Rate limits are applied per project, not per API key » ([Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), « Last updated 2026-09-02 UTC »).
- TIERS, mesure communautaire du 02/09/2026 ([dev.to, « Gemini's free tier, measured »](https://dev.to/romeroyang/geminis-free-tier-measured-20-requests-a-day-and-google-no-longer-publishes-the-number-4gf2)) :

| Modèle | RPM | RPD |
|---|---|---|
| `gemini-3.7-flash`, `3.6-flash`, `3.5-flash`, `3-flash-preview` | 5 | 20 |
| `gemini-3.5-flash-lite`, `3.1-flash-lite` | 15 | 500 |

`gemini-3.8-flash` n'est pas dans cette mesure ; un autre tiers l'annonce à ~20 RPD ([scriptbyai](https://www.scriptbyai.com/gemini-api-free-tier-limits/), non daté précisément). **TPM gratuit : non trouvé.**

**Conséquence pour les 7 clés — SPÉCULATION** : si elles sont dans un même projet Google Cloud, elles partagent un seul quota. Si elles sont dans 7 projets distincts, le quota est multiplié par 7. Les conditions de l'API (en vigueur le 23/03/2026, [Gemini API Terms](https://ai.google.dev/gemini-api/terms)) ne contiennent pas de clause explicite sur ce point d'après la lecture faite, mais multiplier des projets pour contourner un quota reste une pratique à risque de suspension. À ne pas fonder un produit dessus.

**Données — CONFIRMÉ** (mêmes conditions) : au palier gratuit, « human reviewers may read, annotate, and process your API input and output » et « Do not submit sensitive, confidential, or personal information to the Unpaid Services ». Pour un agent de code : acceptable sur le code personnel de Kongo, **pas** sur le code d'un client, et **jamais** avec un fichier de secrets dans le contexte.

**Benchmarks annoncés par Google — CONFIRMÉ comme déclaration du fournisseur** ([fiche DeepMind Gemini 3.8 Flash](https://deepmind.google/models/model-cards/gemini-3-8-flash/), septembre 2026) :

| Benchmark | 3.8 Flash | 3.7 Flash | Opus 5 (cité par Google) |
|---|---|---|---|
| DeepSWE v1.1 | 73,7 % | 65,3 % | 74,0 % |
| Terminal-Bench 2.1 | 89,4 % | 85,8 % | 89,1 % |
| Terminal-Bench 4.0 | 19,1 % | 11,2 % | 51,8 % |

La dernière ligne est la plus instructive : sur la version saturée (2.1), Flash égale Opus ; sur la version dure (4.0), l'écart est de 1 à 2,7.

### 1.2 Groq (palier gratuit)

**Limites gratuites — CONFIRMÉ** ([Groq, Rate limits](https://console.groq.com/docs/rate-limits), page sans date) : « Rate limits apply at the organization level ».

| Modèle | RPM | RPD | TPM | TPD |
|---|---|---|---|---|
| `openai/gpt-oss-120b` | 30 | 1 000 | 8 000 | 200 000 |
| `openai/gpt-oss-20b` | 30 | 1 000 | 8 000 | 200 000 |
| `qwen/qwen3.8-27b` | 30 | 1 000 | 8 000 | 200 000 |
| `openai/gpt-oss-safeguard-20b` | 30 | 1 000 | 8 000 | 200 000 |

Changement depuis le 12/09 : `groq/compound` et `groq/compound-mini` **n'apparaissent plus** dans le tableau gratuit.

**Modèles de code présents** ([Groq, Models](https://console.groq.com/docs/models), sans date) : `openai/gpt-oss-120b`, `openai/gpt-oss-20b` (production), `qwen/qwen3.8-27b` (aperçu). **Aucun Kimi, GLM, DeepSeek ni Qwen Coder dédié** au catalogue lu ce jour.

| Modèle | Contexte | Sortie max | Outils | Source |
|---|---|---|---|---|
| `openai/gpt-oss-120b` | 131 072 | 65 536 | oui | [fiche Groq](https://console.groq.com/docs/model/openai/gpt-oss-120b) — CONFIRMÉ |
| `qwen/qwen3.8-27b` | 131 072 (sur Groq ; natif 262 144) | 16 384 | oui (« tool calling for software engineering workflows ») | [fiche Groq](https://console.groq.com/docs/model/qwen/qwen3.8-27b) — CONFIRMÉ |

**Le piège décisif — CONFIRMÉ en interne** : la mémoire projet du 13/09/2026 (« Plafond jetons Groq ») a observé que Groq renvoie une 413 dès qu'une requête dépasse le plafond TPM (7 000-8 000 jetons). Une requête de boucle de code dépasse ce seuil dès le deuxième ou troisième tour. **Groq gratuit ne peut pas porter la boucle.** Il reste idéal pour les appels de moins de ~7 000 jetons.

### 1.3 Mistral (statut de la clé incertain)

**Offre — CONFIRMÉ** ([Mistral, Pricing](https://mistral.ai/pricing), sans date) : le plan Free donne « $10 /mo in API credits », avec retrait de l'entraînement possible (« Opt-out »). Aucun plan « Experiment » n'apparaît plus. Des tiers décrivent encore un plan Experiment gratuit avec ~1 milliard de jetons/mois et un point d'accès `codestral.mistral.ai` à clé personnelle ([pricepertoken](https://pricepertoken.com/endpoints/mistral/free) et autres) — **TIERS, contredit par la page officielle, à vérifier dans la console**.

**Modèles de code — CONFIRMÉ** ([Mistral, Models overview](https://docs.mistral.ai/getting-started/models/models_overview/), sans date) :
- **Devstral est entièrement retiré** : `devstral-2512` (Devstral 2) déprécié le 22/05/2026, **retiré le 31/07/2026**, remplaçant officiel « Mistral Medium 3.5 ». Tous les autres Devstral sont retirés depuis mars 2026.
- **Codestral** : `codestral-2508` (v25.08), spécialisé complétion et remplissage au milieu (FIM), pas un modèle d'agent. 256 K de contexte selon des tiers ; 128 K selon le catalogue Vercel.
- **Mistral Medium 3.5** : « frontier-class multimodal model optimized for agentic and coding use cases », 256 K de contexte, appel de fonctions, 1,50 / 7,50 $/M, poids ouverts ([fiche modèle](https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04), sortie 28/04/2026).

**Identifiant exact : incohérence non résolue.** La fiche affiche `mistral-medium-3-5` ; le catalogue lu le 12/09 affichait `mistral-medium-3-5-26-04` ; un résumé automatique de la page de ce jour a rendu `mistral-medium-3504` (probablement une erreur de lecture). **À trancher par un `GET /v1/models` avec la clé de Kongo**, lancé par lui.

**Benchmarks de Mistral Medium 3.5 : non trouvés** sur la fiche officielle.

### 1.4 Cloudflare Workers AI

**Allocation — CONFIRMÉ** ([Workers AI, Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), mis à jour le 17/09/2026) : 10 000 neurones/jour gratuits pour tous, puis 0,011 $ / 1 000 neurones sur Workers Paid.

**Modèles de code** :

| Identifiant | Contexte | Outils | Prix entrée / sortie ($/M) | Gratuit ? | Source |
|---|---|---|---|---|---|
| `@cf/openai/gpt-oss-120b` | 128 000 | oui | 0,35 / 0,75 | oui | [fiche](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/) — CONFIRMÉ |
| `@cf/openai/gpt-oss-20b` | non relevé | non relevé | 0,20 / 0,30 | oui | page Pricing — CONFIRMÉ |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | non relevé | non relevé | 0,66 / 1,00 | oui | page Pricing — CONFIRMÉ ; génération 2024, dépassée |
| `@cf/moonshotai/kimi-k2.7-code` | 262 144 | oui, multi-tours | 0,95 / 4,00 (cache 0,19) | **non** | [fiche](https://developers.cloudflare.com/workers-ai/models/kimi-k2.7-code/) — CONFIRMÉ |
| `@cf/zai-org/glm-5.3`, `glm-5.3-flash`, `glm-5.2` | 1 M (5.3) | oui | 1,40 / 4,40 (5.3) | **non** | page Pricing — CONFIRMÉ |
| `@cf/deepseek-ai/deepseek-v4-flash-0731`, `deepseek-v4-pro-0813` | non relevé | non relevé | 0,44 / 1,32 (flash) | **non** | page Pricing — CONFIRMÉ |

Citation exacte : « Some models require a paid billing method. This applies to `@cf/moonshotai/kimi-k2.6`, `@cf/moonshotai/kimi-k2.7-code`, `@cf/zai-org/glm-5.2`, `@cf/zai-org/glm-5.3`, `@cf/zai-org/glm-5.3-flash`, `@cf/deepseek-ai/deepseek-v4-flash-0731`, and `@cf/deepseek-ai/deepseek-v4-pro-0813`. »

**Conversion en jetons — SPÉCULATION arithmétique** à partir du taux de 0,011 $/1 000 neurones : `gpt-oss-120b` ≈ 31 800 neurones par million de jetons d'entrée et ≈ 68 200 par million de sortie. Les 10 000 neurones quotidiens ≈ **250 000 jetons d'entrée + 30 000 de sortie**, soit moins d'une tâche moyenne par jour.

### 1.5 Vercel AI Gateway (~5 $/mois)

**CONFIRMÉ** ([AI Gateway Pricing](https://vercel.com/docs/ai-gateway/pricing), last_updated 2026-09-08 ; [FAQ](https://vercel.com/docs/ai-gateway/faq), 2026-09-13 ; [Rate Limits](https://vercel.com/docs/ai-gateway/rate-limits), 2026-09-08) :
- aucune majoration sur les jetons ;
- le palier gratuit est un crédit mensuel inclus, **limité à un sous-ensemble de modèles**, avec des limites par modèle plus basses et non publiées (« this page describes behavior rather than fixed numbers ») ;
- **acheter des crédits fait passer au palier payant et supprime définitivement le crédit mensuel gratuit** ;
- une 403 `customer_verification_required` exige un moyen de paiement pour utiliser les crédits gratuits ;
- Vercel ne s'entraîne pas sur les invites et ne les conserve pas ; le catalogue expose un champ `no_training` par modèle.

**Montant de 5 $ : TIERS** (plusieurs guides, dont [agentjournal.dev](https://agentjournal.dev/blog/vercel-ai-gateway-free/)) ; la page officielle ne chiffre pas le crédit.

**Liste du sous-ensemble gratuit : TIERS**, non vérifiable sans compte (la page filtrée se construit côté navigateur). Liste rapportée par une synthèse de recherche : GPT-OSS 120B, GPT-5.4 Mini, Gemma 4 31B, Gemini 2.5 Flash, Qwen 3.8 Flash Next, GLM 5.3 Flash, Kimi K2.7 Code, MiniMax M3, Nemotron 3 Super, Llama 4 Maverick, Grok 4.6, DeepSeek V3.2 Thinking. Dans le catalogue public, seuls trois modèles portent l'étiquette `free` et un prix nul : `poolside/laguna-s-2.1-free` (256 K, outils), `inclusionai/ling-3.0-flash-sante` et sa variante `-free` — CONFIRMÉ (catalogue `ai-gateway.vercel.sh/v1/models`, lu le 28/09/2026).

**Prix des modèles de code au catalogue public — CONFIRMÉ** (même catalogue, $/M, contexte, `tools` supporté pour tous) :

| Identifiant Vercel | Sortie | Contexte | Entrée / sortie |
|---|---|---|---|
| `openai/gpt-oss-120b` | 08/2025 | 131 K | 0,10 / 0,50 |
| `deepseek/deepseek-v4.1-flash` | 08/09/2026 | 1 M | 0,30 / 1,20 |
| `deepseek/deepseek-v4-flash` | 23/04/2026 | 1 M | 0,13 / 0,26 |
| `alibaba/qwen3.8-27b` | 14/08/2026 | 1 M | 0,50 / 3,00 |
| `alibaba/qwen3.8-flash` | 26/08/2026 | 991 K | 0,15 / 0,47 |
| `zai/glm-5.3-flash` | 26/08/2026 | 1 M | 0,15 / 0,50 |
| `zai/glm-5.3` | 18/08/2026 | 1 M | 1,40 / 4,40 |
| `moonshotai/kimi-k2.7-code` | 12/06/2026 | 256 K | 0,95 / 4,00 |
| `moonshotai/kimi-k3` | 16/07/2026 | 1 M | 3,00 / 15,00 |
| `minimax/minimax-m3` | 31/05/2026 | 512 K | 0,30 / 1,20 |
| `mistral/mistral-medium-3.5` | 29/04/2026 | 262 K | 1,50 / 7,50 |
| `google/gemini-3.8-flash` | 02/09/2026 | 1 M | 0,75 / 3,75 |
| `poolside/laguna-s-2.1` | 20/07/2026 | 1 M | 0,10 / 0,20 |
| `anthropic/claude-sonnet-5` | 29/06/2026 | 1 M | 2,00 / 10,00 |
| `anthropic/claude-opus-5` | 24/07/2026 | 1 M | 5,00 / 25,00 |
| `openai/gpt-5.6-luna` | 09/07/2026 | 1,05 M | 0,20 / 1,20 |

**Ce que 5 $ achètent — SPÉCULATION arithmétique**, pour une tâche moyenne de 25 tours (≈ 625 000 jetons d'entrée, 15 000 de sortie, sans cache ; voir §4) : `gpt-oss-120b` ≈ 0,07 $/tâche → ~70 tâches/mois ; `deepseek-v4.1-flash` ≈ 0,21 $ → ~24 ; `kimi-k2.7-code` ≈ 0,65 $ → ~7 ; `claude-sonnet-5` ≈ 1,40 $ → ~3. Avec un cache d'invite efficace, diviser l'entrée par 3 à 10 (voir le ratio mesuré par Terminal-Bench au §2.2).

### 1.6 Autres paliers gratuits réels

**OpenRouter — CONFIRMÉ** ([Limits](https://openrouter.ai/docs/api-reference/limits), sans date) : modèles `:free` à 20 requêtes/min ; 50/jour si moins de 10 $ d'achats cumulés, 1 000/jour au-delà (« granted starting one credit below the table's threshold »).
Modèles `:free` avec appel d'outils — CONFIRMÉ (catalogue public `openrouter.ai/api/v1/models`, lu le 28/09/2026) :

| Identifiant | Ajouté | Contexte |
|---|---|---|
| `qwen/qwen3.8-27b:free` | 14/08/2026 | 262 144 |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 04/06/2026 | 1 000 000 |
| `nvidia/nemotron-3-super-120b-a12b:free` | 11/03/2026 | 262 144 |
| `poolside/laguna-s-2.1:free`, `laguna-xs-2.1:free` | 07/2026 | 262 144 |
| `cohere/north-mini-code:free` | 17/06/2026 | 256 000 |
| `thinkingmachines/inkling:free`, `inkling-small:free` | 07/2026 | 1 048 576 |
| `google/gemma-4-31b-it:free`, `gemma-4-26b-a4b-it:free` | 04/2026 | 262 144 |

Attention données (rappel du rapport du 12/09) : réglage séparé gratuit/payant pour autoriser ou non les fournisseurs qui entraînent.

**NVIDIA NIM (build.nvidia.com)** :
- CONFIRMÉ : le catalogue public `integrate.api.nvidia.com/v1/models` (81 modèles, lu le 28/09/2026) contient `moonshotai/kimi-k3`, `moonshotai/kimi-k2.6`, `z-ai/glm-5.3`, `z-ai/glm-5.3-flash`, `deepseek-ai/deepseek-v4.1-flash`, `nvidia/nemotron-3-ultra-550b-a55b`, `openai/gpt-oss-20b`. Point d'accès compatible OpenAI.
- TIERS : ~40 requêtes/minute par défaut, limites « not published » et variables selon le modèle ; ancien système à 1 000 crédits abandonné ([forum NVIDIA](https://forums.developer.nvidia.com/t/request-for-nvidia-nim-api-rate-limit-increase-40-200-rpm/375340), [decodethefuture](https://decodethefuture.org/en/nvidia-nim-api-pricing-limits-guide/)).
- Conditions d'usage (essai, évaluation, non-production ?) et politique d'entraînement : **non vérifiées**. À lire avant tout usage régulier.

**GitHub Models — CONFIRMÉ retiré** : « fully retired on July 30, 2026 » ([GitHub Changelog, 30/07/2026](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/)).

**Cerebras** : palier gratuit disparu (rapport du 12/09, TIERS non recontrôlé ce jour).

---

## 2. Benchmarks qui comptent pour un agent

### 2.1 L'état des classements au 28/09/2026

| Classement | Dernière mise à jour | Verdict |
|---|---|---|
| SWE-bench Verified ([swebench.com](https://www.swebench.com/)) | dernière entrée datée 26/02/2026 (données embarquées de la page) | **gelé et discrédité** : OpenAI a cessé de le publier le 23/02/2026 pour contamination et tests défectueux ([OpenAI](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/) — page en 403 pour l'outil de lecture, contenu et date TIERS via [codesota](https://www.codesota.com/news/swe-bench-contamination-debate)) |
| SWE-bench Pro public ([Scale Labs](https://labs.scale.com/leaderboard/swe_bench_pro_public)) | date non affichée | vivant mais ne contient que des modèles de 2025 pour les modèles ouverts ; OpenAI aurait ensuite relevé ~30 % de tâches défectueuses (TIERS, [startuphub](https://www.startuphub.ai/ai-news/artificial-intelligence/2026/openai-flags-major-flaws-in-swe-bench-pro)) |
| Terminal-Bench 4.0 ([tbench.ai](https://www.tbench.ai/leaderboard)) | 21/09/2026 | **le seul classement officiel vivant et discriminant** |
| Terminal-Bench 2.1 | version du 06/05/2026 | **saturé** : les fournisseurs annoncent 85-91 % |
| Aider Polyglot ([aider.chat](https://aider.chat/docs/leaderboards/)) | 20/11/2025 | figé ; aucun modèle de 2026 |
| LiveCodeBench ([officiel](https://livecodebench.github.io/leaderboard.html)) | problèmes jusqu'au 07/04/2025 | figé ; les « LiveCodeBench v6 » cités par les fournisseurs sont auto-déclarés |
| BFCL v4 ([Berkeley](https://gorilla.cs.berkeley.edu/leaderboard.html)) | 12/04/2026 | appel d'outils ; pas de modèle de 2026 hormis quelques-uns de fin 2025 |

### 2.2 Terminal-Bench 4.0 — classement officiel complet (CONFIRMÉ)

Données embarquées de [tbench.ai/leaderboard](https://www.tbench.ai/leaderboard), mise à jour 21/09/2026. Taux de résolution ± IC 95 %.

| Rang | Harnais | Modèle | Effort | Score | Coût total | Jetons |
|---|---|---|---|---|---|---|
| 1 | Codex | GPT-6 Astra | max | 58,2 % ± 2,8 | 3 267 $ | 1,5 G |
| 2 | Claude Code | Fable 5.1 | max | 57,9 % ± 3,8 | 6 244 $ | 2,7 G |
| 8 | Claude Code | Opus 5 | xhigh | 53,9 % ± 3,4 | 6 086 $ | 6,9 G |
| 16 | Claude Code | **GLM-5.3** | max | **41,8 % ± 3,2** | 2 728 $ | 8,7 G |
| 17 | Grok Build | Grok 4.7 | xhigh | 37,6 % | 3 683 $ | 5,5 G |
| 18 | Codex | GPT-5.6 Sol | max | 37,3 % | 2 542 $ | 4,4 G |
| 23 | mini-SWE-agent | **Gemini 3.8 Flash** | high | **19,1 % ± 3,4** | 1 829 $ | 17,2 G |
| 24 | Codex | GPT-5.6 Luna | max | 17,3 % | 347 $ | 11,6 G |
| 25 | Claude Code | Sonnet 5 | max | 12,4 % | 9 604 $ | 21,6 G |
| 27 | mini-SWE-agent | Gemini 3.7 Flash | high | 11,2 % | 1 262 $ | 11,1 G |

Deux enseignements :
- **GLM-5.3, un modèle à poids ouverts disponible gratuitement en essai chez NVIDIA, est le meilleur modèle non propriétaire du classement, à 41,8 %.** C'est le candidat « cerveau » le plus crédible parmi les accès de Kongo.
- **Le cache est vital** : l'entrée de tête (GPT-6 Astra) montre 1,44 G de jetons d'entrée en cache sur 1,53 G au total (94 %). Un agent qui ne réutilise pas un préfixe stable paie ou consomme dix fois plus.

### 2.3 SWE-bench Verified — classement officiel (CONFIRMÉ, gelé au 26/02/2026)

Extraits pertinents (données embarquées de swebench.com) : `mini-SWE-agent` est le harnais « bash seul » de référence.

| Score | Date | Modèle / harnais |
|---|---|---|
| 79,2 % | 12/2025 | Claude 4.5 Opus + harnais tiers |
| 75,8 % | 17/02/2026 | Gemini 3 Flash (high), mini-SWE-agent |
| 75,8 % | 17/02/2026 | MiniMax M2.5 (high), mini-SWE-agent |
| 72,8 % | 17/02/2026 | GLM 5 (high), mini-SWE-agent |
| 70,8 % | 17/02/2026 | Kimi K2.5 (high), mini-SWE-agent |
| 70,0 % | 17/02/2026 | DeepSeek V3.2 (high), mini-SWE-agent |
| 55,4 % | 02/08/2025 | Qwen3-Coder 480B, mini-SWE-agent |
| 53,8 % | 09/12/2025 | Devstral (2512), mini-SWE-agent |
| **26,0 %** | 07/08/2025 | **gpt-oss-120b**, mini-SWE-agent |

À comparer à la fiche Groq de `gpt-oss-120b` : « SWE-Bench Verified (Coding): 62.4% » (CONFIRMÉ comme déclaration du fournisseur). **Même modèle, facteur 2,4 selon le harnais et l'effort de raisonnement.** C'est un argument fort pour investir dans le harnais de l'agent maison.

### 2.4 SWE-bench Pro public (CONFIRMÉ, [Scale Labs](https://labs.scale.com/leaderboard/swe_bench_pro_public))

Harnais SWE-Agent, 731 instances, certains à 50 tours et coût plafonné : `minimax-2.1` 36,8 % ; `gemini-3-flash` 34,6 % ; `kimi-k2-instruct` 27,7 % ; `qwen3-235b-a22b` 21,4 % ; `gpt-oss-120b` 16,2 % ; `deepseek-v3p2` 15,6 % ; `glm-4.6` 9,7 %. **Aucun modèle de mi-2026** : inutilisable pour trancher entre Qwen 3.8, GLM-5.3, Kimi K3, DeepSeek V4.1.

### 2.5 Chiffres déclarés par les fournisseurs pour les modèles accessibles (non comparables entre eux)

| Modèle | Déclaration | Source | Statut |
|---|---|---|---|
| `qwen3.8-27b` | SWE-bench Pro 61,7 ; Terminal-Bench 2.1 73,0 ; DeepSWE 1.1 42,2 ; LiveCodeBench v6 90,3 | [Hugging Face Qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B), août 2026 | CONFIRMÉ (auto-déclaré) |
| GLM-5.3 | Terminal-Bench 2.1 88,2 (harnais Claude Code) | [MindStudio](https://www.mindstudio.ai/blog/glm-5-3-coding-benchmarks) | TIERS |
| Kimi K3 | Terminal-Bench 2.1 88,3 ; DeepSWE 67,5 | [NxCode](https://www.nxcode.io/resources/news/kimi-k3-benchmarks-coding-agent-evaluation-guide-2026) | TIERS |
| Kimi K2.7 Code | uniquement des benchmarks maison Moonshot à sa sortie (12/06/2026) | [Codersera](https://codersera.com/blog/kimi-k2-7-complete-guide-2026/) | TIERS |
| DeepSeek V4.1 Flash | Terminal-Bench 2.1 90,6 ; DeepSWE 74,2 (sortie 10/09/2026) | [MindStudio](https://www.mindstudio.ai/blog/deepseek-v4-1-flash-benchmarks) | TIERS |
| Gemini 3.8 Flash | voir §1.1 | fiche DeepMind | CONFIRMÉ (auto-déclaré) |

**SPÉCULATION — lecture honnête** : sur les versions saturées, tout le monde se vaut ; sur la seule mesure indépendante et dure (TB 4.0), les modèles Flash sont 2 à 3 fois en dessous des modèles de pointe. Pour Kongo, le vrai juge sera **son propre jeu de tâches** (§6.6), pas ces tableaux.

---

## 3. Appel d'outils et fenêtre de contexte des modèles retenus

| Modèle (accès) | Contexte | Outils natifs | Fiabilité mesurée de l'appel d'outils |
|---|---|---|---|
| `gemini-3.8-flash` (Gemini) | 1 048 576 | oui | non trouvée pour 3.8 ; BFCL v4 : Gemini 3 Pro Preview 72,5 % en mode invite contre 68,1 % en mode natif |
| `gemini-3.5-flash-lite` (Gemini) | non relevé (1 M au catalogue Vercel) | oui (Vercel : `tools`) | non trouvée ; BFCL : Gemini 2.5 Flash-Lite 36,9 % (ancienne génération) |
| `qwen/qwen3.8-27b` (Groq 131 K ; OpenRouter gratuit 262 K) | 131 072 / 262 144 | oui | non trouvée ; BFCL : Qwen3 32B 48,7 % (génération précédente) |
| `openai/gpt-oss-120b` (Groq, Cloudflare, Vercel) | 131 072 / 128 000 | oui | non trouvée dans BFCL |
| `z-ai/glm-5.3` (NVIDIA ; Cloudflare payant) | 1 M | oui (Cloudflare : « reasoning, function calling, and structured outputs ») | BFCL : GLM-4.6 72,4 %, 4e sur 109 — la famille GLM est historiquement forte à l'outil |
| `moonshotai/kimi-k3` (NVIDIA ; Vercel payant) | 1 M | oui | BFCL : Kimi K2 Instruct 59,1 % (ancienne génération) |
| `moonshotai/kimi-k2.7-code` (Cloudflare payant, Vercel) | 262 144 | oui, multi-tours | non trouvée |
| `deepseek-ai/deepseek-v4.1-flash` (NVIDIA, Vercel) | 1 M | oui (Vercel : `tools`) | BFCL : DeepSeek V3.2-Exp 54,1 % natif / 56,7 % invite+réflexion |
| `mistral-medium-3-5` (Mistral) | 256 K | oui | non trouvée ; BFCL : Mistral Medium 2505 37,6 % (ancienne génération) |

Sources : fiches citées au §1 ; BFCL — CONFIRMÉ, fichier de données `data_overall.csv` de [gorilla.cs.berkeley.edu](https://gorilla.cs.berkeley.edu/leaderboard.html), « Last Updated 2026-04-12 ».

**Ce que ça dit pour la conception — SPÉCULATION** :
- BFCL compare « FC » (outils natifs de l'API) et « Prompt » (outils décrits dans l'invite). Les deux modes se valent à quelques points près ; parfois l'invite gagne. La boucle actuelle d'Astratra (`<tool_call>` dans le texte) n'est donc pas disqualifiée, mais le mode natif réduit les erreurs de format et permet les appels parallèles. **Prévoir les deux**, choisis par modèle.
- La fiabilité d'outil de la génération 2026 **n'est mesurée nulle part de façon indépendante**. Il faudra la mesurer soi-même : taux d'appels bien formés, taux de `remplacer` réussis du premier coup (Aider publiait exactement ce chiffre : « percent well-formed edits »).

---

## 4. Évaluation réaliste : combien de tours par jour ?

### 4.1 Le poids d'un tour — SPÉCULATION chiffrée

Préfixe fixe, envoyé à chaque appel :
- instructions système de l'agent : ~1 500 jetons ;
- 8 définitions d'outils × ~250 : ~2 000 ;
- règles du projet (`AGENTS.md`) : 500 à 1 500 ;
- carte du dépôt : ~1 000 (valeur par défaut d'Aider, `--map-tokens` — CONFIRMÉ, [aider.chat/docs/repomap](https://aider.chat/docs/repomap.html)).

Soit **≈ 5 000 à 6 000 jetons** avant la moindre action.

Ajout par tour : ~500 jetons de sortie du modèle (hors réflexion), plus le résultat de l'outil — lecture de 200 lignes ≈ 2 500, recherche ≈ 500, sortie de tests tronquée ≈ 1 000. Moyenne ≈ 1 500.

Les API étant sans état, chaque appel renvoie tout l'historique. Au tour *k*, l'entrée vaut ≈ 5 500 + 1 500 × *k*.

| Tâche | Tours | Entrée cumulée | Sortie cumulée |
|---|---|---|---|
| petite (corriger un bug localisé) | 10 | ≈ 140 000 | ≈ 5 000 (+ réflexion) |
| moyenne (fonction + test + ajustements) | 25 | ≈ 625 000 | ≈ 12 500 (+ réflexion) |
| difficile (Terminal-Bench 4.0) | des centaines | 20 à 50 millions par essai (données TB 4.0 : 6,9 G / 330 essais pour Opus 5 ; 17,2 G / 330 pour Gemini 3.8 Flash) | — |

Les modèles à réflexion multiplient la sortie par 2 à 5. La compaction (§5.4) plafonne l'entrée par appel (par exemple à 40 000) mais ne réduit pas le nombre d'appels.

### 4.2 Capacité par accès — SPÉCULATION

| Accès | Contrainte dominante | Tâches moyennes/jour | Usage conseillé |
|---|---|---|---|
| Groq gratuit (×3 modèles) | 8 000 jetons/min = plafond par requête | **0** pour la boucle | petites tâches < 7 000 jetons : ~25 appels/jour/modèle (200 K ÷ 8 K) |
| Gemini Flash récent, 1 projet | 20 RPD | < 1 | planification, revue finale |
| Gemini Flash-Lite, 1 projet | 500 RPD, 15 RPM, TPM inconnu | ~15-20 si le TPM suit | ouvrier de la boucle, explorateur à grand contexte |
| Cloudflare 10 000 neurones | ≈ 250 K jetons d'entrée | < 0,5 | réserve de secours |
| Vercel 5 $/mois | crédit | ~2/jour avec `gpt-oss-120b`, ~0,25/jour avec Kimi K2.7 Code | secours payé, modèles absents ailleurs |
| OpenRouter `:free`, < 10 $ d'achats | 50 RPD | ~2 | — |
| OpenRouter `:free`, ≥ 10 $ d'achats (une fois) | 1 000 RPD, 20 RPM | **~40** | ouvrier principal : `qwen/qwen3.8-27b:free` |
| NVIDIA NIM | ~40 RPM, pas de quota journalier publié | **inconnue, potentiellement élevée** | cerveau : `z-ai/glm-5.3`, `moonshotai/kimi-k3` |
| Mistral 10 $/mois | crédit | ~0,3/jour avec Medium 3.5 | secours avec clause de non-entraînement activable |

### 4.3 Le routage qui tire le maximum — SPÉCULATION

Quatre rôles, pas une chaîne unique :

1. **Cerveau** (plan initial, édition difficile, décision d'arrêt) : NVIDIA `z-ai/glm-5.3` → NVIDIA `moonshotai/kimi-k3` → `gemini-3.8-flash` (20/jour) → Vercel (sous-ensemble gratuit) → Mistral Medium 3.5.
2. **Ouvrier** (les tours de lecture, recherche, édition simple) : OpenRouter `qwen/qwen3.8-27b:free` → `gemini-3.5-flash-lite` → NVIDIA `deepseek-ai/deepseek-v4.1-flash` → Cloudflare `@cf/openai/gpt-oss-120b`.
3. **Petites mains** (< 7 000 jetons : résumer une sortie de tests pour la compaction, rédiger un message de validation, classer le risque d'une commande) : Groq `openai/gpt-oss-20b` → `openai/gpt-oss-120b` → `qwen/qwen3.8-27b`.
4. **Explorateur** (sous-agent qui lit beaucoup de fichiers et rend un résumé) : modèle à 1 M de contexte et à fort quota, `gemini-3.5-flash-lite`.

Règles de routage :
- **Ne pas changer de modèle en cours de tâche sans raison** : on perd le cache et la cohérence de style. On monte d'un cran (ouvrier → cerveau) après deux échecs de tests consécutifs, pas à chaque tour.
- **Le routeur doit connaître la taille maximale de requête**, pas seulement RPM/RPD/TPD : Groq refuse au-delà de son TPM. Nouveau champ à ajouter au catalogue (`maxRequestTokens`).
- **Code client ou sensible** : exclure les paliers gratuits qui entraînent (Gemini gratuit, OpenRouter gratuit selon réglage, NVIDIA à vérifier) ; ne garder que Groq, Cloudflare, Vercel avec `no_training`, Mistral avec retrait activé.
- **Budget réaliste** : avec ces accès, un agent maison traitera bien les tâches petites et moyennes, à quelques dizaines par jour. Il ne rivalisera pas sur les tâches longues des classements. **Dix dollars une fois chez OpenRouter** sont la meilleure dépense possible ; au-delà, 10 à 20 $/mois sur un modèle de type DeepSeek V4.1 Flash donneraient de la marge (attention : acheter chez Vercel supprime le crédit gratuit mensuel).

---

## 5. Comment sont conçus les agents de code qui marchent

### 5.1 La boucle : simple, et le modèle décide

- Anthropic distingue les *workflows* (chemins codés) des *agents* (le modèle dirige) et recommande de commencer simple et de n'ajouter de complexité que si elle se mesure — CONFIRMÉ ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), 19/12/2024).
- Le harnais SWE-bench d'Anthropic se résume à deux outils (bash + éditeur) et un flux suggéré, pas imposé — CONFIRMÉ ([Raising the bar on SWE-bench Verified](https://www.anthropic.com/engineering/swe-bench-sonnet), 06/01/2025).
- `mini-SWE-agent` : ~100 lignes, **aucun outil autre que bash**, un sous-processus indépendant par action, historique linéaire, plus de 74 % sur SWE-bench Verified — CONFIRMÉ ([dépôt GitHub](https://github.com/SWE-agent/mini-swe-agent)).
- OpenAI décrit la boucle de Codex (entrée → modèle → appels d'outils → résultats réinjectés → jusqu'à la réponse), et sa migration vers l'API Responses pour mieux exploiter le cache — TIERS pour le détail (article officiel [« Unrolling the Codex agent loop »](https://openai.com/index/unrolling-the-codex-agent-loop/) inaccessible en lecture automatique ; résumé [Emil Sit, 02/2026](https://www.emilsit.net/t/2026/02/unrolling-the-codex-agent-loop-openai/)).

### 5.2 Les outils : peu, précis, conçus comme une interface

- **L'interface agent-machine (ACI)** : SWE-agent a montré que des commandes pensées pour le modèle — visionneuse de fichier fenêtrée, recherche, édition avec garde de lint, retours concis — changent le résultat — CONFIRMÉ ([arXiv 2405.15793](https://arxiv.org/abs/2405.15793), v3 du 11/11/2024).
- **Remplacement par correspondance exacte** : `old_str` doit correspondre exactement à une suite de lignes, et **une seule fois** ; zéro ou plusieurs correspondances renvoient une erreur qui fait réessayer — CONFIRMÉ (article SWE-bench d'Anthropic).
- **Chemins absolus** : les imposer a nettement amélioré la précision — CONFIRMÉ (Building effective agents).
- **Formats d'édition** : Aider maintient plusieurs formats (fichier entier, recherche/remplacement, variante clôturée pour Gemini, diff unifié) parce que chaque famille de modèles en rate certains ; mode architecte = un modèle raisonne, un autre applique — CONFIRMÉ ([Aider, edit formats](https://aider.chat/docs/more/edit-formats.html)).
- **Principes d'outil** : moins d'outils mais mieux ciblés, espaces de noms, réponses économes en jetons avec pagination et troncature par défaut, erreurs qui disent quoi faire, descriptions travaillées comme des invites, itération guidée par l'évaluation — CONFIRMÉ ([Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents), 11/09/2025).

### 5.3 Vérifier en exécutant

« Give Claude a check it can run: tests, a build, a screenshot to compare » ; sans vérification exécutable, « looks done » est le seul signal ; montrer la preuve (commande et sortie) plutôt qu'affirmer — CONFIRMÉ ([Best practices for Claude Code](https://code.claude.com/docs/en/best-practices), page sans date). Le même guide décrit une barrière déterministe (un script bloque la fin du tour tant que le test échoue) et un relecteur en contexte neuf qui ne voit que le diff.

### 5.4 Le contexte, ressource principale

- Récupération au moment voulu (on garde des identifiants et on lit à la demande), **compaction** (résumer l'historique à l'approche de la limite), **notes structurées** hors contexte, **sous-agents** à contexte propre qui rendent un résumé — CONFIRMÉ ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), 29/09/2025).
- « performance degrades as it fills » ; repartir d'un contexte propre après deux corrections ratées ; demander que la compaction conserve la liste des fichiers modifiés et les commandes de test — CONFIRMÉ (Best practices).
- **Carte du dépôt** : Aider extrait classes, fonctions et signatures avec tree-sitter, classe les fichiers par un algorithme de graphe sur les dépendances et remplit un budget de ~1 000 jetons — CONFIRMÉ ([repomap](https://aider.chat/docs/repomap.html)).

### 5.5 Planifier

Explorer → planifier → implémenter → valider ; le plan est inutile quand le diff tient en une phrase — CONFIRMÉ (Best practices, « plan mode »).

### 5.6 Bac à sable et permissions

- Codex en local : restrictions au niveau du système (Seatbelt via `sandbox-exec` sur macOS, `bwrap` + `seccomp` sur Linux), **réseau coupé par défaut**, écriture limitée à l'espace de travail, et **`.git`, `.agents`, `.codex` en lecture seule même en mode écriture** ; deux couches distinctes : le mode de bac à sable (ce qui est possible) et la politique d'approbation (quand demander) — CONFIRMÉ ([Codex, Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security), sans date).
- Listes blanches de commandes et isolement système pour réduire les demandes sans perdre le contrôle — CONFIRMÉ (Best practices).

### 5.7 Sécurité git

Les points de reprise automatiques ne capturent que les éditions faites par l'outil d'édition, pas les changements faits en shell : « This isn't a replacement for git » — CONFIRMÉ (Best practices). Codex protège `.git` en écriture (§5.6). Aucune source officielle lue ne publie une liste de commandes git interdites : la liste du §6.4 est une proposition (SPÉCULATION), alignée sur la règle de Kongo « jamais de commande qui jette le travail non commité ».

### 5.8 Sous-agents et coût

Un agent consomme ~4 fois plus de jetons qu'un échange simple, un système multi-agents ~15 fois ; le multi-agents paie pour la recherche très parallélisable, **moins pour le code**, dont les parties sont interdépendantes — CONFIRMÉ ([How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)). Conclusion pour un budget gratuit : sous-agents seulement pour explorer (lecture seule, résumé court) et pour relire le diff.

### 5.9 Mémoire des règles du projet

`AGENTS.md` : format Markdown ouvert, sans champ obligatoire (commandes de build et de test, style, sécurité, conventions de commit) ; dans un monorepo, **le fichier le plus proche dans l'arborescence l'emporte**, et la demande explicite de l'utilisateur prime sur tout ; « stewarded by the Agentic AI Foundation under the Linux Foundation » — CONFIRMÉ ([agents.md](https://agents.md/)). Le guide d'Anthropic ajoute : fichier court, chaque ligne doit éviter une erreur, et ce qui doit arriver à chaque fois relève d'un crochet déterministe, pas d'une consigne.

---

## 6. Proposition : l'agent de code de Kongo sur Astratra

Nom de travail dans ce document : **l'Artisan** (à remplacer par le nom retenu ; il s'inscrit dans la lignée d'Oracle et de Tertius). Générique : aucune règle, aucun texte, aucun chemin propre à Scolaris.

### 6.1 Ce qui existe et se réutilise tel quel

| Paquet | Rôle dans l'agent de code |
|---|---|
| `@astratra/ai` — `createProviderRouter` | quotas RPM/RPD/TPD par couple fournisseur:modèle, refroidissement après 429, dégradation, ordre de bascule, Redis optionnel |
| `@astratra/ai` — `createOpenAICompatibleProvider` | un seul adaptateur pour Gemini (point compatible OpenAI, non revérifié ce jour), Groq, OpenRouter, NVIDIA, Mistral, Vercel, Cloudflare ; relit la clé à chaque appel, ne la met jamais dans une erreur, gère déjà `tools` / `tool_calls` natifs et signale les arguments mal formés (`invalid: true`) |
| `@astratra/ai` — `createToolRegistry` | registre d'outils avec `type` et `roles` |
| `@astratra/ai` — `createPendingActions` (le sas) | tout geste irréversible (pousser, publier, supprimer, réseau) est proposé, un humain approuve ; une exécution jamais deux ; `amend` |
| `@astratra/ai` — disjoncteurs par fournisseur, `isProviderOutage` | une panne n'emporte que son fournisseur |
| `@astratra/resilience` | disjoncteur, relance avec brouillage, verrou si l'agent tourne un jour en tâche de fond |
| `@astratra/memory` | règles apprises par projet (`{ ownerId: utilisateur, scope: identifiant du dépôt }`), refus par codes, règle `secret` intégrée |
| `@astratra/rag` | découpage et recherche hybride, utile pour une recherche sémantique dans la documentation du dépôt (son découpage est pensé pour des documents ; le code demande un découpage par fonction, à ajouter) |
| `@astratra/credentials` | clés chiffrées, jamais dans un fichier du dépôt ni sur la sortie standard |
| `@astratra/tooling` | ses motifs de `audit:secrets` servent de filtre avant envoi au modèle |
| `@astratra/i18n-server` | catalogue des messages montrés à l'utilisateur |

### 6.2 Ce que la boucle actuelle ne sait pas faire (constaté dans `packages/ai/src/agentLoop.js`)

- **un seul appel d'outil par tour** (`parseToolCall` prend la première balise) ;
- **un outil inconnu ou un JSON invalide lève une exception** et tue la tâche, au lieu d'être renvoyé au modèle comme un code d'erreur ;
- l'historique est **aplati en une seule chaîne** à chaque tour : pas de messages structurés, pas d'appels natifs, cache d'invite moins efficace ;
- `maxSteps` à 5 par défaut ; un agent de code en demande 30 à 100 ;
- résultats d'outils sérialisés en entier, sans troncature ni pagination ;
- aucune gestion de la taille du contexte (compaction).

Décision proposée : **ne pas alourdir `runAgentLoop`**, qui sert bien Oracle. Écrire une seconde boucle, orientée messages, dans le nouveau paquet, qui réutilise le routeur, le registre et le sas.

### 6.3 Le nouveau paquet : `@astratra/code` (outils de code)

**Espace de travail**
- une racine unique ; tout chemin est résolu en absolu (`realpath`), refusé s'il sort de la racine, y compris par lien symbolique ;
- **liste de refus de lecture** : `.env*`, `*.pem`, `*.key`, dossiers de clés, et tout ce qu'ignore `.gitignore` sauf levée explicite ; filtre de secrets sur chaque contenu avant qu'il n'atteigne le modèle ;
- détection des fichiers binaires et des fichiers géants.

**Outils (sept au départ, noms internes libres)**
1. `lire` — chemin absolu, décalage, nombre de lignes ; numéros de ligne ; plafond par défaut (~250 lignes) ; enregistre l'empreinte du fichier lu.
2. `chercher` — expression régulière via ripgrep, filtre de fichiers, résultats plafonnés avec l'indication « N résultats de plus ».
3. `lister` — motif glob, trié par date de modification, plafonné.
4. `remplacer` — `ancien` / `nouveau`, correspondance **exacte et unique** ; codes d'erreur `not_found`, `ambiguous` (avec le nombre d'occurrences), `stale` (le fichier a changé depuis sa lecture) ; refusé si le fichier n'a pas été lu dans la session.
5. `ecrire` — création de fichier ; écraser un fichier existant exige de l'avoir lu.
6. `executer` — commande avec liste blanche par projet (issue d'`AGENTS.md` ou d'un fichier de configuration), délai, sortie tronquée (tête et queue), répertoire confiné, environnement expurgé des secrets, réseau coupé en phase 2.
7. `tester` — la commande de test déclarée pour le projet (ou une cible précise), renvoie un résumé (réussis / échoués / premiers échecs) plutôt que la sortie brute.

Plus `diff` (état git et diff de la session) en lecture seule.

Chaque outil porte un `type` : `lecture`, `ecriture`, `execution`, `irreversible`. Le type pilote la politique d'approbation.

### 6.4 La garde git (le point non négociable)

- **Refusées toujours**, quel que soit le mode : `git checkout -- …`, `git checkout .`, `git restore` (hors `--staged`), `git reset --hard`, `git clean -f*`, `git stash drop` / `clear`, `git push --force*`, `git branch -D`, `git rebase` sur une branche partagée, `rm -rf` visant un chemin suivi par git. La détection se fait sur la commande analysée, pas par simple sous-chaîne.
- **`.git` en lecture seule** pour les outils d'écriture (comme Codex).
- **Journal d'annulation propre** : avant chaque `remplacer` / `ecrire`, copie de l'état antérieur du fichier ; « annuler » restaure depuis ce journal, jamais depuis git.
- **Photographie au démarrage** : `git status --porcelain` enregistré ; en fin de session, l'agent liste les fichiers qu'il a touchés et signale tout fichier modifié hors de sa liste.
- **Aucune validation (commit) ni poussée sans demande explicite** ; la poussée passe par le sas.
- Phase 3 : option « une tâche = un arbre de travail git séparé ».

### 6.5 Permissions et bac à sable

Trois modes, calqués sur la séparation de Codex entre ce qui est possible et quand demander :
1. **Lecture** — outils `lecture` seulement.
2. **Atelier** — écriture dans la racine et commandes de la liste blanche sans demander ; toute autre commande est demandée.
3. **Manuel** — chaque écriture et chaque commande est demandée.

Les gestes `irreversible` passent **toujours** par `createPendingActions`, quel que soit le mode.
Phase 2 : exécution des commandes sous `sandbox-exec` (macOS) ou `bwrap` (Linux/VPS), réseau coupé, écriture limitée à la racine et au dossier temporaire.

### 6.6 La boucle orientée messages

- messages structurés (système, utilisateur, assistant, outil) ; **appels d'outils natifs** quand le modèle les gère bien, repli sur le format `<tool_call>` sinon (choix par modèle, mesuré) ;
- **plusieurs appels par tour** (lectures parallèles) ;
- toute erreur d'outil revient au modèle sous forme de **code** (principe déjà en place dans Astratra) ; jamais d'exception qui tue la tâche pour une faute du modèle ;
- **préfixe stable** (instructions, outils, `AGENTS.md`, carte du dépôt) et historique en ajout seul, pour profiter du cache d'invite ;
- **budgets** : tours, temps, jetons, et coût estimé par tâche, affichés à l'utilisateur ;
- **compaction** au-delà d'un seuil (par exemple 60 % du contexte du modèle) : les vieux résultats d'outils sont résumés par une « petite main » ; on garde toujours la demande initiale, le plan, la liste des fichiers modifiés, les commandes de test et le dernier résultat de test ;
- **barrière de vérification** : l'agent ne peut pas déclarer « terminé » si des fichiers ont été modifiés depuis le dernier passage réussi de `tester` ; il doit soit relancer les tests, soit dire explicitement pourquoi il ne peut pas.

### 6.7 Contexte du dépôt et mémoire des règles

- **`AGENTS.md`** lu à la racine et dans chaque dossier parent du fichier concerné, le plus proche l'emporte (standard §5.9) ; c'est la source de vérité versionnée des règles du projet.
- **Règles apprises** : quand l'utilisateur corrige l'agent (« ne lance jamais la suite complète »), l'agent **propose** d'ajouter la règle à `AGENTS.md` (édition soumise à approbation) ; `@astratra/memory` garde seulement les préférences personnelles qui n'ont pas leur place dans le dépôt.
- **Carte du dépôt** : phase 1, arborescence et symboles exportés extraits par expressions régulières selon le langage ; phase 2, tree-sitter et classement par graphe de dépendances (méthode d'Aider), budget ~1 000 jetons.
- **Recherche** : ripgrep d'abord ; recherche sémantique (`@astratra/rag`, vecteurs locaux) seulement si l'évaluation montre qu'elle aide.

### 6.8 Routage avec le routeur d'Astratra

- un fournisseur `createOpenAICompatibleProvider` par accès ; modèles déclarés avec `rpm`, `rpd`, `tpd`, et **un nouveau champ `maxRequestTokens`** (Groq : ~7 000) que le routeur doit respecter avant l'appel ;
- `intentRouting` par rôle : `plan` (cerveau), `step` (ouvrier), `summarize` et `small` (petites mains), `explore` (explorateur) — ordres proposés au §4.3 ;
- un disjoncteur par fournisseur (`breakers`) ;
- une **étiquette de sensibilité par projet** (`prive` / `client`) qui retire du routage les paliers gratuits qui entraînent ;
- clés via `@astratra/credentials`, jamais écrites dans le dépôt, jamais sur la sortie standard.

### 6.9 Aucun texte en dur

- Tout ce que l'utilisateur lit (invites de l'interface, demandes d'approbation, erreurs, résumés de fin) passe par un catalogue de traduction ; les outils renvoient des **codes** (`not_found`, `ambiguous`, `stale`, `denied`, `tool_timeout`).
- Les instructions système destinées au **modèle** ne sont pas du texte d'interface ; on les garde dans un fichier de gabarits versionné, séparé du code (la langue la plus efficace pour le modèle peut être l'anglais, à mesurer).

### 6.10 Plan par phases

**Phase 0 — mesurer (1 à 2 jours, par Kongo avec ses clés)**
- vérifier les vrais plafonds : une requête de 20 000 jetons sur chaque accès (TPM effectif, 413 ou non), `GET /v1/models` chez Mistral pour l'identifiant exact, conditions d'usage de NVIDIA NIM, projets Google derrière les 7 clés ;
- constituer **le jeu d'évaluation** : 20 à 30 tâches réelles tirées des dépôts de Kongo, chacune avec un test qui échoue avant et passe après (le principe de SWE-bench, sur ses propres dépôts, donc sans contamination).

**Phase 1 — MVP terminal (lecture, édition, tests)**
- `@astratra/code` : espace de travail, les sept outils, garde git, journal d'annulation ;
- boucle orientée messages, un seul agent, mode **Manuel** par défaut, `AGENTS.md`, compaction simple, barrière de vérification ;
- routage : ouvrier + cerveau, deux ou trois accès seulement ;
- critère de sortie : taux de réussite mesuré sur le jeu d'évaluation, plus le taux de `remplacer` réussis du premier coup et les jetons par tâche.

**Phase 2 — autonomie encadrée**
- bac à sable système, réseau coupé, mode **Atelier** ;
- carte du dépôt tree-sitter ; routeur à quatre rôles ; affichage du budget ;
- choix appel natif / `<tool_call>` par modèle, d'après les mesures.

**Phase 3 — contexte et qualité**
- sous-agent explorateur (lecture seule, résumé court), sous-agent relecteur du diff en contexte neuf ;
- mode plan ; règles apprises proposées vers `AGENTS.md` ; arbre de travail par tâche.

**Phase 4 — au-delà du terminal**
- mode sans interface pour les scripts et l'intégration continue ; mode serveur avec diffusion en direct ; interface web ou éditeur ;
- raccord à la famille (Oracle, Tertius) : même socle, même routeur, personnalité propre.

### 6.11 Risques à garder en tête

- **Quotas mouvants** : Google a retiré ses tableaux de limites, Groq a retiré Compound du gratuit en deux semaines, Devstral a disparu en deux mois. Le catalogue de modèles doit vivre dans une configuration, jamais dans le code, avec un test de fumée quotidien.
- **Gratuit = données exposées** : un agent de code lit tout le dépôt. Le filtre de secrets et la liste de refus ne sont pas optionnels.
- **Coût caché des modèles à réflexion** : la sortie de réflexion compte dans les quotas de jetons.
- **Le harnais est le produit** : l'écart de 26 % à 62 % sur le même modèle (§2.3) dit où investir.

---

## 7. Ce qui n'a pas pu être vérifié

- limites gratuites Gemini par modèle (seulement une mesure tierce, sans `gemini-3.8-flash` ni TPM) ;
- liste exacte du sous-ensemble gratuit de Vercel et montant officiel du crédit ;
- limites et conditions d'usage de NVIDIA NIM ;
- identifiant exact de Mistral Medium 3.5 et existence actuelle d'un point d'accès Codestral gratuit ;
- fiabilité d'appel d'outils des modèles de 2026 (aucun classement indépendant à jour) ;
- l'article d'OpenAI sur l'abandon de SWE-bench Verified (403 à la lecture ; contenu connu par des tiers) ;
- l'existence et l'adresse du point d'accès compatible OpenAI de Gemini n'ont pas été relues ce jour.
