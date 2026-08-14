# Astratra — Design @astratra/ai (V0)

## Contexte

Quatrième package du monorepo Astratra. C'est le morceau le plus complexe :
L'application source avait un pipeline IA multi-provider (Groq, Cerebras, Mistral, Gemini,
Ollama) avec fallback, quotas, dégradation, et un agent à tool-calling
(boucle d'agent interne d'environ 1400 lignes).

Constat après lecture du code source :

- `provider.manager.js` (1093 lignes) contient DEUX choses mélangées :
  1. Un **moteur générique** de routing/quota/fallback (fenêtre RPM glissante,
     compteurs RPD/TPD journaliers, cooldown 429 + jitter, dégradation après
     échecs consécutifs, état partagé Redis optionnel avec repli RAM, reset à
     minuit, sélection ordonnée par "intent" puis "complexity") — c'est la
     vraie propriété intellectuelle réutilisable, indépendante du domaine
     scolaire.
  2. Des **catalogues de modèles produit en dur** (IDs précis Groq/Gemini/
     Mistral, dates de vérification, `INTENT_ROUTING` avec des intents
     scolaires comme `FINANCIAL_QUERY`/`GRADES_QUERY`) — spécifique, à ne
     PAS extraire tel quel.

- `tool.registry.js` : structure de registre déjà propre (`getToolsForRole`,
  `getToolByName`, `formatToolsForPrompt`), mais le tableau `TOOLS` est 100%
  lié au domaine source et `ALL_ROLES` est codé
  en dur avec des rôles métier. Le **mécanisme** de registre est générique,
  son **contenu** ne l'est pas.

- `agent.loop.js` (1433 lignes) : boucle d'agent complète avec streaming,
  buffering à seuil, confirmation humaine, gestion d'images, logique
  spécifique à chaque type de complexité. Porter cette taille et cette
  complexité fidèlement en une seule passe serait un risque de qualité élevé
  et sortirait largement du "moins risqué d'abord" qui a guidé Astratra
  jusqu'ici. **Décision : construire une boucle d'agent générique et plus
  simple pour la V0** (parse `<tool_call>`, exécute via le registre, boucle
  jusqu'à réponse finale ou nombre max d'itérations), pas un portage 1:1.
  l'application source garde sa propre boucle plus riche ; `@astratra/ai` fournit la
  brique de base sur laquelle un futur projet peut construire la sienne.

## Package : @astratra/ai

Dépend de `@astratra/core`.

### 1. `providerRouter` — moteur générique multi-provider

`createProviderRouter(config)` où `config.providers` est un tableau fourni par
le consommateur :

```js
{
  id: 'my-provider',
  models: [{ id: 'model-a', rpm: 30, rpd: 1000, tpd: 200000, complexity: ['simple','medium'] }],
  call: async (prompt, ctx, model) => { /* retourne un async iterable de chunks, ou une string */ }
}
```

Le routeur porte le mécanisme générique de `provider.manager.js` :
- fenêtre RPM glissante par modèle
- compteurs RPD/TPD journaliers avec reset à minuit (`setTimeout` interne,
  arrêtable via `router.stop()`)
- cooldown avec jitter après erreur 429
- dégradation après N échecs consécutifs (configurable, défaut 3, durée
  configurable, défaut 5 min)
- réservations de quotas Redis **atomiques** (si `config.redisUrl` fourni),
  avec clés par `providerId:modelId`; repli RAM local si Redis est absent ou
  indisponible, sans prétention de quota distribué dans ce cas
- sélection ordonnée : `routing` optionnel par intent (`config.intentRouting`,
  même forme que `INTENT_ROUTING` mais fourni par le consommateur, vide par
  défaut) puis par `complexity`

`router.ask(prompt, { complexity, intent, estimatedTokens, maxTokens }, ctx)` —
essaie les providers dans l'ordre de `config.providers` (le consommateur
choisit déjà l'ordre de fallback, contrairement au projet source qui avait un ordre
Groq→Cerebras→Mistral→Gemini→Ollama en dur), utilise le premier modèle
disponible selon les règles ci-dessus, retourne le résultat de `call()`. Lève
une erreur explicite si aucun provider/modèle n'est disponible (pas de message
de repli type "je suis indisponible" en dur — ça, c'est au consommateur de le
gérer avec le message qu'il veut).

`router.getStats()` — même forme que l'original (rpm_now, rpd_used, cooldown,
degraded, failures), indexée par `providerId:modelId`, utile pour un futur
dashboard.

Pas de complexité "assessComplexity" automatique par défaut (l'algorithme d'origine
regarde le texte du prompt et des heuristiques propres à son usage) — le
consommateur passe `complexity` explicitement. Un exemple simple de
`assessComplexity` peut être documenté dans le README mais pas imposé comme
valeur par défaut invisible.

### 2. `toolRegistry` — registre d'outils générique

`createToolRegistry()` retourne :
- `registry.register(tool)` où `tool = { name, description, type, roles,
  params, handler }` (`handler` = fonction async exécutée par la boucle d'agent)
- `registry.getToolsForRole(role)`
- `registry.getToolByName(name)`
- `registry.formatToolsForPrompt(role)` — même format texte que l'original
  (nom, description, paramètres), pour injection dans un prompt système

Aucun outil pré-enregistré. Le registre est vide par défaut — un projet
scolaire y enregistrerait `get_student_results`, un projet clinique y
enregistrerait `get_patient_record`, etc.

### 3. `agentLoop` — boucle générique minimale

`runAgentLoop({ prompt, ctx, history, registry, router, userRole, maxSteps })` :

1. Construit le prompt systeme avec `registry.formatToolsForPrompt(userRole)`
   (le consommateur fournit son propre préfixe de prompt métier, le
   registre ne fournit que la liste d'outils formatée).
2. Appelle `router.ask(...)`.
3. Parse la réponse à la recherche d'un bloc `<tool_call name="...">{json
   params}</tool_call>` (même convention textuelle que le projet source, format
   simple et déjà éprouvé).
4. Si trouvé : vérifie que l'outil existe et que `userRole` y a accès, exécute
   `tool.handler(params, ctx)`, réinjecte le résultat dans l'historique comme
   `<tool_result>`, boucle (jusqu'à `maxSteps`, défaut 5).
5. Si pas de tool_call : retourne la réponse telle quelle comme réponse
   finale.

Pas de streaming côté V0 (streaming token par token avec buffering à
seuil — complexité réelle, reportée). Pas de gestion d'image, pas de
confirmation humaine avant exécution d'un outil `write` — **ces deux points sont explicitement hors
périmètre V0**, à couvrir dans un futur spec si un projet concret en a besoin.

## Tests

- `providerRouter` : sélection du bon modèle selon complexity/intent,
  cooldown après 429, dégradation après échecs répétés, reset RPD/TPD à
  minuit (test avec horloge mockée), fonctionnement sans Redis.
- `toolRegistry` : filtrage par rôle, formatage du prompt.
- `agentLoop` : boucle simple sans tool_call (réponse directe), boucle avec un
  tool_call (exécution puis réponse finale), refus d'un outil hors rôle,
  arrêt à `maxSteps`.

Aucune dépendance à une vraie clé API — tous les providers sont mockés dans
les tests (`call` retourne des réponses fixes).

## Hors périmètre V0

- Catalogues de modèles réels (Groq/Gemini/Mistral/Cerebras/Ollama) : à
  documenter en exemple dans le README, pas en code du package.
- Streaming token par token.
- Confirmation humaine avant exécution d'un outil sensible.
- Gestion d'images / vision.
- `assessComplexity` automatique.
- Recherche web intégrée (`web_search`, `hybrid_research`) : ce
  sont des outils métier, pas une brique du framework — un projet consommateur
  les enregistrerait lui-même via `toolRegistry.register`.
