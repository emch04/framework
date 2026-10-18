# Changelog — `@astratra/centrale`

Format inspiré de [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Les entrées 1.0.0 à 1.4.0 reprennent
celles du [journal des changements du monorepo](../../CHANGELOG.md).

## 1.7.0 — 2026-10-18 : signatures de pensée de Gemini 3

### Modifié
- `/passerelle` : `modeleDiscussion(p)` rend aussi `thoughtSignatures: true`. La passerelle relaie les signatures de
  pensée de Gemini 3 (`tool_calls[i].extra_content.google.thought_signature`) ; passé à `askChatModel` ou à
  `createOpenAICompatibleProvider` de `@astratra/ai` 1.12.0, il les fait repartir avec l'historique. Sans elles, Gemini 3
  refusait tout tour d'outil (400). Aucun autre paquet Astratra n'est tiré.

## 1.5.0 — 2026-10-15 : moins de fausses alertes

Trois sources de fausses erreurs relevées en production le 15/10/2026 ne sont plus signalées.

### Modifié
- `/navigateur` : un navigateur piloté par un robot (`navigator.webdriver` vrai : Playwright, Selenium, Puppeteer) ne
  collecte plus rien ; `demarrer` rend une instance inactive (`actif === false`). Nouvelle option `robots: true` pour
  collecter quand même (tester la collecte). Raison : 57 fausses erreurs venaient des tests Playwright d'une app,
  comptées en production.
- `/vigilance` (gardien du fil principal) : un retard de la minuterie de plus de 60 s n'est plus un blocage
  (`AppBloquee`) mais une pause de l'app (téléphone verrouillé, onglet endormi : JavaScript a été suspendu avant
  d'apprendre le passage en arrière-plan). Seule une miette « Pause de l'app N s » est gardée. Option `plafondMs` de
  `surveillerBlocages` (60 000 par défaut). Raison : 59 « blocages » d'une app sur iPhone, jusqu'à 2 181 s.
- `/expo` : l'état `inactive` d'`AppState` (centre de contrôle, sélecteur d'apps, verrouillage en cours) met aussi le
  gardien en pause ; `active` le relance.
- `/vigilance` (requêtes `fetch`) : les vérifications de connexion des systèmes et des bibliothèques
  (`generate_204` de Google, `captive.apple.com`, `www.apple.com/library/test/success.html`, `msftconnecttest.com`,
  `detectportal.firefox.com`) restent dans le fil d'Ariane mais ne sont plus signalées. Nouvelle fonction exportée
  `estVerificationDeConnexion(adresse)`. Raison : 83 fausses erreurs sur `clients3.google.com/generate_204`.
- `VERSION_SDK` passe à 1.5.0 (envoyé avec chaque lot, il était resté à 1.4.0) ; un test vérifie désormais qu'il suit
  la version du paquet.

### Documentation
- README français et anglais : option `robots`, section sur les tests automatisés, vérifications de connexion, pause de
  l'app et état `inactive`. README anglais : option `stockage` d'Expo, déjà décrite en français.

## 1.4.0 — 2026-10-10 : recherche récente par la passerelle

### Ajouté
- `rechercher` : option `periode` (`heure`, `jour`, `semaine`, `mois`, `an`) pour des résultats récents ; la réponse
  porte l'encadré de réponse (`encadre`) et la fiche (`fiche`) de Google, et chaque résultat sa `date` et ses sous-liens
  (`liens`) quand Google les donne. Types `PeriodeRecherche`, `ReponseRecherche` ; tests.

## 1.3.0 — 2026-10-10 : client de la passerelle des clés

### Ajouté
- Entrée `/passerelle` : `lirePasserelle(env)` (`CENTRALE_ADRESSE`, `CENTRALE_PASSERELLE_JETON`, jeton `clj_pas_…`
  vérifié, HTTPS hors boucle locale), `modeleDiscussion(p)` (modèle `auto` au format OpenAI), `plongements`,
  `rechercher`, `voix`, et `passerelleDabord` (la passerelle d'abord, les clés directes seulement en cas de panne).
- `PasserelleIndisponible` (injoignable, délai, 5xx, 429, 401/403, 503) et `RequetePasserelleRefusee` (400, 413, sans
  repli) ; tests.

## 1.2.0 — 2026-10-10 : surveillance renforcée

### Ajouté
- Entrée `/vigilance` (aussi exportée par la racine), branchée par défaut dans `/navigateur` et `/expo` : requêtes
  `fetch` dans le fil d'Ariane et signalées quand elles échouent (`RequeteSansReponse`, `RequeteEchouee`) ;
  `console.error` signalé, `console.warn` dans le fil d'Ariane ; gardien du fil principal (`AppBloquee`).
- Expo : promesses rejetées sans `catch` (Hermes), alerte mémoire d'iOS (`MemoireSaturee`), premier plan, arrière-plan
  et lancement dans le fil d'Ariane ; option `stockage` pour garder l'état entre deux lancements (session restée
  ouverte close « anormale » ou « plantage », `FermetureInattendue` avec le fil d'Ariane et l'écran).
- Navigateur : mêmes capteurs ; `stockage` facultatif (un seul onglet).
- Cœur : `filAriane()`, `sessionPrecedente(id, etat)`, option `filAriane` des erreurs. `VERSION_SDK` passe à 1.2.0.
- Options `requetes`, `console`, `blocages`, `promesses` (vraies par défaut) ; tests.

## 1.1.0 — 2026-10-09 : client de la conscience d'une IA

### Ajouté
- Entrée `/conscience` : `creerConscienceCentrale({ adresse, jeton })`, client léger des routes « conscience » du
  tableau de bord. `lireReglages()` (ETag, un 304 rend la copie), `envoyerBilan(rapport, propositions?)`,
  `lireDecisions()`, `accuserDecision` / `accuserDecisions` (`failed` n'est pas accusé). Erreurs `ErreurConscience`.
- `resumerBilan` et `nettoyerMesures` : le bilan est réduit à des identifiants, des codes et des nombres avant l'envoi.
- Toujours sans dépendance (vérifié par test). README anglais (`README.en.md`) ; types ; tests.

## 1.0.3 — 2026-10-09 (sécurité)

### Corrigé
- Masquage : les règles des jetons (JWT, `Bearer`/`Basic`, clés à préfixe) avaient des répétitions sans borne ; une
  suite piégée « eyJ-eyJ-… » restait quadratique. Chaque segment est borné ; test de non-régression étendu.

## 1.0.2 — 2026-10-09 (sécurité)

### Corrigé
- Masquage : la règle des adresses e-mail était quadratique sur une longue chaîne sans « @ ». Elle est bornée (64
  caractères avant l'arobase, 255 après) et sautée sans « @ ». Test de non-régression.

## 1.0.1 — 2026-10-09 : documentation neutre

### Modifié
- Commentaires, description et données de test sans noms de projets d'origine ; aucun comportement ne change.

## 1.0.0 — 2026-10-07 : nouveau paquet

### Ajouté
- Paquet de collecte d'un tableau de bord de surveillance auto-hébergé (erreurs, plantages, vues, usages, sessions,
  appels d'IA), masqués à la source et envoyés par lots. Entrées `/node`, `/navigateur`, `/expo`, `/ia`, plus `/envoi`
  (le contrat d'envoi) et `/masquage`, repris par le backend. Aucune dépendance. Écrit en TypeScript, publié construit
  (`dist/`, par `prepack`).
