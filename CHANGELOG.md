# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Chaque package Astratra est versionné indépendamment.

## 2026-08-25 (19)

### Ajoute

- `create-astratra-app` (`1.2.0`→`1.3.0`) — les onze briques optionnelles
  accessibles à la génération : `--with payments,privacy,notify` ou
  `--with all`. Le générateur ne connaissait que le socle historique
  (`core`, `security`, `ai`, `saas-kit`) ; tout le reste était invisible depuis
  la ligne de commande.
  - Chaque brique demandée fait deux choses : elle s'ajoute aux dépendances, et
    elle écrit un fichier d'exemple CÂBLÉ POUR CE PROJET sous `api/bricks/`
    (ou `web/src/lib/` pour le navigateur) — pas un extrait de README à
    recopier, du code qui compile et qu'on branche quand on veut.
  - Rien n'est ajouté sans qu'on l'ait demandé : la plupart de ces packages
    n'ont aucune dépendance précisément pour qu'on n'en prenne que ce dont on a
    besoin. Sans `--with`, le projet généré est exactement celui d'avant, et un
    test le vérifie.
  - Rien n'est câblé dans `server.js` — même choix que pour `store-mongo`, déjà
    scaffoldé sans être branché : une application fraîchement générée doit
    démarrer sans configuration, pas réclamer six variables d'environnement
    avant son premier `npm run dev:api`.
  - `client` et `prerender` touchent au navigateur ou au build : demandées sur
    le gabarit `api`, elles sont REFUSÉES plutôt que silencieusement ignorées.
    `--with all` prend ce que le gabarit accepte — neuf briques en `api`, onze
    en `fullstack`.
  - Un nom fautif liste les noms valides, et l'échec arrive AVANT qu'un seul
    fichier soit écrit.
  - 3 → 13 tests, dont un qui passe `node --check` sur les onze fichiers
    générés : un exemple qui ne compile pas est pire qu'aucun exemple, on le
    découvre en le branchant et pas en le lisant.

## 2026-08-25 (18)

### Ajoute

- `@astratra/prerender` (`0.1.1`→`0.2.0`) — le sitemap, tiré de la MÊME liste
  que les pages. Un sitemap est presque toujours écrit à la main, sans lien avec
  les routes, et les deux divergent. La panne est silencieuse : le fichier dit à
  un robot d'aller chercher une URL jamais prérendue, l'hébergeur retombe sur
  son repli SPA, et le robot reçoit la PAGE D'ACCUEIL — titre et description
  compris — sous cette adresse. C'est le doublon que `auditPages` détecte du
  côté du rendu ; ceci ferme le même trou du côté de l'annonce.
  - `routes` accepte désormais une ligne de table `{ path, label?, lastmod?,
    changefreq?, priority?, sitemap? }` en plus d'une simple chaîne — l'ancien
    contrat continue de fonctionner tel quel.
  - `sitemap: false` sur une route la prérend sans l'annoncer : une page de
    connexion mérite d'exister pour un robot qui suit un lien, pas une place
    dans un plan de site.
  - L'option `sitemap` vaut `false` par DÉFAUT, délibérément : beaucoup de
    projets ont un `public/sitemap.xml` recopié dans `dist` par Vite, et
    l'écraser sans qu'on l'ait demandé serait une surprise destructrice.
  - Sans génération, un `dist/sitemap.xml` existant est RELU SANS ÊTRE TOUCHÉ et
    ses URLs sans page remontent dans `warnings` — un avertissement et non une
    erreur, car un site sain peut lister des URLs rendues ailleurs (pages
    serveur, contenu dynamique) dont ce prérendu n'a aucune connaissance.
  - `buildSitemap` et `auditSitemap` sont exportées pour qui garde son propre
    pipeline et n'emprunte que le contrôle.
  - 20 → 34 tests, dont trois d'intégration sur un vrai navigateur : le fichier
    écrit, la route exclue du plan mais bien rendue, et le sitemap manuel dont
    les trous sont signalés sans être réécrits.

## 2026-08-25 (17)

### Change — consolidation

Vingt-quatre packages, c'est vingt-quatre README, vingt-quatre changelogs et
vingt-quatre versions à faire vivre. Trois fusions ramènent le compte à vingt,
sans forcer personne à embarquer du code non voulu.

- `@astratra/mailer` est ABSORBÉ par `@astratra/notify` (`0.1.0`→`0.2.0`) —
  désormais « les messages sortants » : e-mail, SMS, notifications poussées.
  Même nature, même architecture (transport injecté, ne lève jamais, absence de
  configuration visible), et personne n'installe l'un sans vouloir l'autre un
  jour. Aucune API ne change : `createMailer`, `renderEmail`, `sanitizeHeader`
  et les autres s'importent maintenant depuis `@astratra/notify`.
- `@astratra/session-client` et `@astratra/offline` sont FUSIONNÉS en
  `@astratra/client` (`0.1.0`) — la plomberie côté client, agnostique de tout
  framework : session, garde de route, règles de mot de passe, file hors ligne.
  Les deux tournent sur l'appareil de l'utilisateur et répondent à la même
  question — le réseau n'est pas fiable et la session peut mourir. Distinct de
  `@astratra/react`, qui reste la couche de liaison React (contextes, hooks).
- `@astratra/invitations` est ABSORBÉ par `@astratra/entitlements`
  (`0.2.0`→`0.3.0`) — inviter quelqu'un AVEC un rôle est le premier acte du
  cycle de vie des droits, et `entitlements` est déjà le pack « qui a le droit
  de quoi ».

Aucune perte : les 824 tests passent tous, et chaque archive s'installe et se
charge toujours dans un projet vierge.

### Laissé séparé, volontairement

- `@astratra/pdf` et `@astratra/closure` se croisent souvent dans un même
  produit (documents de fin de période) mais c'est une coïncidence d'usage : un
  site vitrine peut vouloir le moteur PDF sans jamais clore quoi que ce soit.
- `payments`, `privacy`, `resilience`, `credentials`, `i18n-server` : chacun
  répond à une question distincte et s'adopte séparément. Les fusionner ferait
  installer du code non désiré.

## 2026-08-25 (16)

### Ajoute

- `@astratra/notify` (`0.1.0`, nouveau package) — SMS et notifications
  poussées, transport injecté. Complète le trio d'envois avec
  `@astratra/mailer`.
  - `createSmsSender({ transport, maxLength })` — ne lève jamais ; sans
    transport, l'envoi est une simulation BRUYANTE (étiquetée dans le journal
    et dans le résultat) — une simulation qui a l'air réelle est pire qu'un
    échec, quelqu'un attend un code qui n'a jamais quitté le journal. Numéro
    nettoyé sans prétendre le valider, texte PLAFONNÉ — un texte non borné
    concaténé dans un SMS est la façon dont un bug devient une facture.
  - `createPushSender({ transport, onGone })` — la leçon qui compte : les
    abonnements MORTS. Un 404/410 n'est pas une erreur à journaliser, c'est un
    fait à traiter — l'abonnement est rendu à `onGone` pour suppression, sinon
    la liste n'accumule que des cadavres (envois lents, journaux bruyants,
    fournisseurs qui étranglent). Trois issues jamais confondues :
    delivered/gone/failed ; un abonnement mort n'arrête pas les autres ; un
    élagage qui échoue ne transforme pas un gone en failed ; le statut du
    fournisseur est cherché où qu'il l'ait mis (web-push et les clients HTTP
    ne sont pas d'accord).
  - 17 tests.

- `@astratra/entitlements` (`0.1.0`→`0.2.0`) — `createTenantScope({ field,
  globalRoles })`. Chaque requête
  multi-locataires doit porter le filtre du locataire, et l'oublier une fois
  montre à une école les élèves d'une autre. La règle qui compte : PAS DE
  LOCATAIRE = AUCUNE LIGNE, jamais toutes les lignes — un compte à moitié
  migré reçoit un filtre impossible, pas une requête sans borne, et
  `onMissingTenant` sonne l'alarme parce qu'un utilisateur sans locataire
  mérite mieux qu'un écran vide silencieux. La requête de l'appelant n'est
  jamais mutée ; `canAccess` compare ObjectId et chaîne comme un même
  locataire. 53 → 65 tests.

### Écarte, volontairement

- Un journal auto-masquant : déjà couvert par le redactor de
  `@astratra/privacy`.
- Le rapport de tests HTML et l'orchestrateur de déploiement : trop liés à la
  structure d'un dépôt donné pour tenir un contrat de package stable.
- Le relais temps réel socket.io : trop peu de logique générique au-delà de ce
  que socket.io fournit déjà (rooms par locataire = trois lignes chez
  l'appelant).

## 2026-08-25 (15)

### Ajoute

- `@astratra/invitations` (`0.1.0`, nouveau package) — inviter quelqu'un par
  lien, une fois, pour un temps. Deux propriétés que les implémentations
  maison oublient : le jeton est stocké en EMPREINTE SHA-256 (le garder en
  clair fait qu'une collection qui fuite permet d'accepter toutes les
  invitations en attente), et l'acceptation est une revendication ATOMIQUE (un
  findOne puis update laisse deux acceptations simultanées créer deux comptes ;
  testé au `Promise.allSettled`). Et une nouvelle invitation retire
  les anciennes pour la même adresse — le vieux lien est ce qui ressort d'une
  boîte mail des mois plus tard.
  - Le rôle vient de l'INVITATION, jamais du formulaire. Un échec de création
    de compte marque `failed`, jamais `used` — « utilisée » pour un compte
    jamais né bloque la personne. Inconnue et déjà utilisée répondent le MÊME
    message : lequel des deux est une information qu'un sondeur de jetons n'a
    pas à obtenir. Un envoi raté ne détruit pas l'invitation. Une invitation
    sans e-mail existe (lien à l'écran, QR code). Une révocation consigne qui a
    fermé, et une invitation tranchée répond 409.
  - Rôles injectés, création de compte injectée, envoi injecté (se marie avec
    `@astratra/mailer`), URL injectée. Aucune dépendance à l'exécution.
  - 18 tests.

## 2026-08-25 (14)

### Ajoute

- `@astratra/session-client` (`0.1.0`→`0.2.0`) — deux briques mobiles de
  produits réels, généralisées.
  - `createRouteGuard({ publicSegments })` — la déconnexion remplaçait l'écran
    du dessus par la page de connexion, toute la pile restait derrière :
    quelques « retour » ramenaient sur le tableau de bord, déconnecté mais
    données à l'écran. Deux décisions portent la protection : la liste nomme ce
    qui est PUBLIC et tout le reste est fermé (une liste d'écrans protégés
    échoue en silence — chaque écran oublié part ouvert), et tant que la
    session se restaure rien n'est décidé (rediriger sur l'état transitoire du
    démarrage éjecte un utilisateur connecté à chaque démarrage à froid).
  - `createPasswordRules({ minLength, conditions })` — chaque condition évaluée
    séparément pour que l'écran coche pendant la frappe, des clés de traduction
    plutôt que des phrases, et AUCUNE dépendance pour que le même module tourne
    à l'écran et sur le serveur — les deux copies qui dérivent sont le bug
    d'origine. `strength()` pour la barre de progression, `canSubmit()` pour la
    condition du bouton.
  - Non extrait, volontairement : le test « des trois portes » de joignabilité
    des écrans lit les fichiers du dépôt consommateur — trop spécifique.
  - 13 → 35 tests.

## 2026-08-25 (13)

### Ajoute

- `@astratra/session-client` (`0.1.0`, nouveau package) — rester connecté sans
  que l'utilisateur le remarque. La mécanique finit toujours par exister en
  double — un intercepteur avec file d'attente côté web, une promesse à vol
  unique côté mobile — avec les mêmes pièges résolus deux fois. Transport et
  stockage injectés : axios ou fetch, cookie ou stockage sécurisé natif, même
  logique. Les trois bugs qui reviennent toujours, réglés une fois :
  la RUÉE (cinq 401 simultanés dépensent UN renouvellement — quatre
  renouvellements en course consommeraient un refresh token tourné et
  déconnecteraient l'utilisateur au moment où tout était rattrapable), la
  BOUCLE INFINIE (`/auth/refresh` et `/auth/login` ne déclenchent jamais de
  renouvellement — un mot de passe faux est un mot de passe faux, pas une
  session expirée), et le REJEU UNIQUE (un second 401 avec une session fraîche
  est une permission refusée, pas un problème de jeton). Expiration définitive
  typée `SessionExpiredError`, annoncée une fois, cause conservée. 13 tests.

- `@astratra/offline` (`0.1.0`, nouveau package) — du travail qui survit à la
  perte du réseau. Stockage injecté (IndexedDB, SQLite, AsyncStorage,
  mémoire). Les règles qui rendent une file digne de confiance : l'ORDRE est
  gardé (« présent » puis « absent » doivent atterrir dans cet ordre) ; une
  PANNE arrête le rejeu au lieu de sauter (sauter rejouerait l'histoire dans le
  désordre — sauter est le réflexe naturel, et il est faux) ; un REFUS du
  serveur (4xx) est mis
  de côté visiblement au lieu de tenir la file en otage — et l'utilisateur
  APPREND qu'un travail qu'il croit sauvegardé ne l'est pas. Une action sans
  gestionnaire est refusée à l'entrée plutôt qu'échouée en silence pour
  toujours ; une action d'une ancienne version de l'app est écartée
  visiblement ; deux rejeux concurrents partagent une exécution. 11 tests.

## 2026-08-25 (12)

### Ajoute

- `@astratra/closure` (`0.1.0`, nouveau package) — fermer une période
  volontairement : année scolaire, exercice comptable, saison. Logique pure, aucune
  dépendance à l'exécution — le contrôleur compte, le package juge.
  - `createClosureChecklist(checks)` — la clôture commence presque toujours
    comme une échéance subie : une tâche passe à minuit et ferme quand une
    condition tient, personne ne voit ce qui manque ni ne décide. La liste rend
    la clôture aux humains. La distinction qui porte tout : `blocking` interdit
    de fermer (une délibération non tranchée engage l'avenir d'un enfant), le
    non-bloquant demande seulement d'être VU (un impayé se négocie). Fermer avec
    des impayés est légitime ; le faire sans avoir regardé ne l'est pas — d'où
    la reconnaissance explicite, avec deux règles testées : aucune
    reconnaissance ne passe au-dessus d'un point bloquant, et cocher d'avance ne
    pré-approuve rien.
  - `createArchiveBuilder({ sections, scrubber })` — une archive se transmet et
    parfois s'envoie par courriel : rien de ce qui permet de se connecter à la
    place de quelqu'un n'y entre, et le nettoyage se fait À LA FRONTIÈRE plutôt
    qu'en faisant confiance à chaque lecteur — la seule version qui survit au
    prochain qui ajoute une collection. Une section en échec ne vide pas
    l'archive et elle est NOMMÉE dans `failed` : une archive à laquelle il
    manque une section en silence a l'air complète et ne l'est pas.
  - 21 tests.

## 2026-08-25 (11)

### Ajoute

- `@astratra/resilience` (`0.1.0`, nouveau package) — trois protections contre
  les dépendances qui tombent. Aucune dépendance à l'exécution.
  - `createCircuitBreaker({ failureThreshold, recoveryMs, isFailure })` — une
    dépendance en panne échoue LENTEMENT : chaque appel attend son délai, les
    requêtes s'empilent, une API tierce morte emporte le service avec elle. Le
    disjoncteur remplace l'échec lent par un échec rapide. Durcissement par
    rapport à l'implémentation naïve : la sonde semi-ouverte est SINGULIÈRE —
    laisser passer tous les appelants en attente « pour tester » livre à
    l'heure exacte le troupeau que le disjoncteur devait empêcher. Une sonde
    qui échoue rouvre immédiatement et le délai repart de là. `isFailure`
    distingue la panne de l'erreur métier : un 404 est une réponse, pas une
    panne. `reset()` pour l'opérateur qui vient de déployer le correctif.
  - `createCache({ store, prefix })` — un cache dont l'absence est survivable :
    un store cassé se lit comme une absence, jamais comme une erreur. `remember`
    fait l'idiome cache-aside avec protection contre la ruée : sous concurrence,
    UN calcul par clé, les appelants parallèles attendent la même promesse.
    `null` n'est pas mis en cache (« rien » aujourd'hui ne doit pas masquer
    « quelque chose » cinq minutes) ; l'éviction mémoire retire le moins
    récemment utilisé, pas la plus vieille écriture. Store injecté : Redis en
    production, mémoire ailleurs, même code.
  - `retry(fn, { attempts, shouldRetry })` — recul exponentiel à brouillage
    complet (l'intervalle fixe synchronise les clients en vagues), et par
    défaut tout statut sous 500 n'est PAS relancé : un 400 est faux et le
    répéter ne le rend pas plus juste. `shouldRetry` protège le non-idempotent.
  - 36 tests, dont la sonde unique sous concurrence réelle et la ruée de cache
    avec `Promise.all`.

## 2026-08-25 (10)

### Ajoute

- `@astratra/ai` (`1.1.0`→`1.2.0`) — deux briques pour un agent qui écrit.
  - `createPendingActions({ store, tools, onPending })` — le sas entre un agent
    qui propose et un humain qui dispose. Un agent autorisé à écrire est
    dangereux d'une façon qu'un agent qui répond n'est pas : le mode de panne
    n'est pas la malveillance mais l'assurance — un destinataire plausible, un
    corps plausible, et une vraie famille reçoit un message que personne n'a
    approuvé. Cycle `proposed → approved → executing → executed/failed` avec
    revendication ATOMIQUE de la transition vers `executing` : deux
    approbations simultanées produisent un envoi, pas deux. `dedupeKey` contre
    le modèle insistant, `amend` pour que l'humain corrige le brouillon (la
    correction est consignée), un outil qui RETOURNE une erreur est marqué
    `failed` et jamais `executed` — « Envoyé » pour un message jamais parti est
    le mensonge que le sas existe pour empêcher. Un canal de notification mort
    ne fait pas échouer l'agent. Seuls les outils du catalogue peuvent
    s'exécuter, même si l'enregistrement a été altéré entre-temps.
  - `createDeterministicFallback({ responders, classify })` — répondre quand
    tous les fournisseurs sont tombés : une réponse calculée SANS modèle depuis
    les données déjà là, plutôt qu'un écran vide. La règle d'honnêteté est la
    partie qui compte : chaque réponse de repli se déclare dégradée — servir
    une réponse dégradée comme si de rien n'était apprend aux utilisateurs à se
    méfier des bonnes. L'erreur du fournisseur est transportée et non avalée
    (la gober cacherait la panne à la supervision), et une question sans
    réponse déterministe est déclinée, pas inventée.
  - 18 → 48 tests. `@astratra/saas-kit` n'a pas besoin de bump : sa dépendance
    `^1.0.0` couvre déjà `1.2.0`.

## 2026-08-25 (9)

### Ajoute

- `@astratra/security` (`1.8.0`→`1.9.0`) — deux briques de confiance interne.
  - `createServiceSigner({ secret, maxAgeMs })` — signer les appels entre ses
    propres services. La porte d'entrée est gardée, les couloirs internes ne le
    sont généralement pas : un service appelle l'autre sur le réseau et celui
    qui reçoit fait confiance à ce qui arrive parce que « c'est interne ».
    Extrait de `shared/utils/proxySign`, avec trois durcissements par rapport à
    l'original : un HORODATAGE placé À L'INTÉRIEUR de la chaîne signée (sans
    lui, qui observe un seul appel signé peut le rejouer indéfiniment ; envoyé
    à côté, il serait simplement réécrit), la signature vérifiée AVANT
    l'analyse de la charge utile (analyser d'abord fait tourner le parseur JSON
    sur ce qu'un attaquant a envoyé), et les clés TRIÉES avant signature — un
    service construit `{ id, role }`, l'autre reconstruit `{ role, id }` depuis
    une ligne de base, et `JSON.stringify` produisait deux chaînes différentes
    pour la même donnée, faisant échouer la vérification par intermittence
    d'une façon qui ressemble à un problème réseau. `headers()` /
    `verifyHeaders()` pour le cas courant d'un service HTTP appelant un autre.
  - `createAuditChain({ store })` — un journal qui montre qu'on l'a modifié.
    Chaque entrée porte l'empreinte de la précédente. `verify()` distingue
    `altered` (le contenu ne correspond plus à son empreinte) de `broken` (une
    entrée a été supprimée ou insérée) : un contenu réécrit est une
    falsification, un maillon rompu veut dire qu'on a retiré ou glissé quelque
    chose. Recalculer l'empreinte d'une entrée modifiée ne suffit pas — tout ce
    qui suit pointe encore sur l'ancienne valeur. Seuls les champs signés
    alimentent l'empreinte, donc une colonne ajoutée plus tard ne lit pas comme
    une falsification. L'écriture NE LÈVE JAMAIS : perdre la trace est grave,
    perdre le paiement qu'elle enregistrait l'est davantage.
  - `stableStringify` — la sérialisation à clés triées, partagée par le signeur
    et la chaîne, parce qu'une signature et une empreinte ont le même besoin.
  - 124 → 159 tests. `@astratra/saas-kit` n'a pas besoin de bump : sa
    dépendance `^1.7.0` couvre déjà `1.9.0`.

## 2026-08-25 (8)

### Ajoute

- `@astratra/mailer` (`0.1.0`, nouveau package) — l'anneau autour de l'envoi
  d'e-mails. Deux implémentations très différentes — SMTP d'un côté, API HTTP
  de l'autre — finissent avec exactement les mêmes protections, écrites deux
  fois. Le transport est injecté, aucune dépendance à l'exécution.
  - `createMailer({ channels })` — NE LÈVE JAMAIS. Un e-mail de confirmation est
    la conséquence d'une action, pas l'action : quand la commande est passée et
    l'argent encaissé, une coupure SMTP ne doit pas devenir un 500 qui annonce
    au client que sa commande a échoué. Chaque appel renvoie un résultat.
    Plusieurs canaux nommés, parce qu'un reçu et une alerte de sécurité n'ont
    pas à partager la même réputation d'expéditeur ni les mêmes identifiants.
    Un canal sans identifiants journalise et laisse passer au lieu de faire
    tomber chaque inscription en développement.
  - `sanitizeHeader` / `sanitizeAddress` / `formatSender` — l'injection
    d'en-têtes. Un saut de ligne dans un sujet ne reste pas dans le sujet : il
    le TERMINE et en commence un nouveau, et un formulaire de contact devient un
    relais de spam. Les mots sont conservés et non supprimés (un sujet amputé en
    silence est un bug qu'on ne comprend jamais) ; une adresse invalide est
    refusée et non réparée (un Reply-To malformé casse toutes les réponses sans
    que personne le signale) ; une seule mauvaise adresse dans une liste ne fait
    pas perdre les autres destinataires.
  - `renderEmail` / `renderText` — l'e-mail n'est pas le web : Outlook met en
    page avec Word, Gmail retire les blocs `<style>`, flexbox et grid n'existent
    pas. Tableaux imbriqués et styles en ligne. Le bouton est un tableau, sinon
    il s'effondre en lien nu dans Outlook. La version texte n'est pas une
    politesse : sans elle le message est moins bien noté par les filtres. Tout
    est échappé — un client nommé « Dupont & Fils <SARL> » casse la mise en page
    bien avant qu'on essaie de t'attaquer.
  - `createCaptureChannel()` — tester les e-mails sans serveur mail, et éviter
    qu'un envoi de développement atteigne une vraie personne.
  - 53 tests.

## 2026-08-25 (7)

### Ajoute

- `@astratra/privacy` (`0.1.0`, nouveau package) — droit d'accès, droit à
  l'oubli, anonymisation des journaux. Aucune dépendance à l'exécution.
  - `createAnonymizer({ fields, onAnonymised })` — l'idée centrale : ANONYMISER,
    PAS SUPPRIMER. Les notes d'un élève, les factures d'un client, les fiches de
    paie ont leur propre conservation légale et appartiennent à l'institution
    autant qu'à la personne ; supprimer le compte les emporte ou les laisse
    orphelines. Ce que la loi demande, c'est que la personne cesse d'être
    identifiable. Un champ que la fiche ne porte pas est ignoré, jamais inventé
    — ajouter `parentPhone` à une fiche de salarié créerait une donnée
    personnelle au moment même de l'effacement. Ne sauvegarde pas : la
    persistance et les transactions restent à l'appelant.
  - `createErasureWorkflow({ store, erase })` — l'effacement passe toujours par
    un humain. Personne n'approuve sa propre demande (la barrière existe pour
    une seconde paire d'yeux), une opération irréversible ne s'exécute pas deux
    fois (409), et un effacement en ÉCHEC est enregistré comme échoué, jamais
    comme terminé — consigner une réussite qui n'a pas eu lieu revient à dire à
    un régulateur qu'on a effacé des données qu'on détient toujours.
  - `createDataExporter({ sources })` — ce que tout le monde rate n'est pas
    l'export mais le SILENCE autour. Une source peut déclarer `elsewhere` : le
    fichier nomme alors ce qu'il ne contient pas au lieu de le cacher. Une
    source injoignable ne fait pas couler l'export mais figure dans
    `unavailable`.
  - `createRedactor({ extra })` — e-mails, téléphones, cartes, jetons Bearer,
    secrets en clair, plus les champs dont le NOM suffit. Les motifs ajoutés
    passent AVANT ceux par défaut : le motif téléphone est volontairement large
    et mangerait le matricule d'un motif sur mesure. Le nom du champ est
    conservé, seule la valeur part. La structure est parcourue et non
    sérialisée — passer par JSON réécrit aussi les clés et corrompt le document
    dès qu'un remplacement contient une accolade. Cycles et profondeur bornés.
  - 48 tests.

## 2026-08-25 (6)

### Ajoute

- `@astratra/payments` (`0.1.0`, nouveau package) — le tuyau des webhooks de
  paiement. La même logique se réécrit à chaque intégration, avec les mêmes
  pièges — le meilleur signal qu'elle mérite d'être écrite une fois. Aucun SDK
  importé : la vérification de signature est injectée.
  - `createWebhookHandler({ verify, secret, events, eventLog })` — le code HTTP
    n'est pas décoratif, le prestataire le lit comme une consigne. Signature
    invalide → 400, jamais 500 : relancer ne changerait rien. Gestionnaire qui
    lève → 500, parce que là une relance peut aider. Tout le reste → 200.
  - `unrelated()` — la leçon la moins évidente. Les webhooks sont à l'échelle du
    COMPTE : un point d'entrée reçoit les événements de tous les flux. Répondre
    404 à ce qui n'est pas pour soi fait relancer le prestataire pendant des
    jours et marque la destination défaillante. On acquitte : « reçu, pas mon
    circuit ».
  - `sideEffect(label, fn)` — l'argent est encaissé et la commande confirmée ;
    un e-mail qui échoue ne doit pas provoquer une relance de tout l'événement.
    L'effet de bord échoue seul, et le journal le dit.
  - `secret` accepte une fonction, relue à chaque appel : le secret se change
    depuis une interface sans redémarrage. Se marie avec `@astratra/credentials`.
  - `eventLog` + `createMemoryEventLog()` — les prestataires renvoient les
    événements par conception. Sans mémoire, la seconde livraison reconfirme la
    commande. Un événement en ÉCHEC n'est pas enregistré : la relance doit
    pouvoir fonctionner. Un événement `unrelated` non plus.
  - `createWebhookExemption({ prefix, suffix })` — un seul prédicat partagé par
    le parseur JSON, le CSRF et les gardes. Dans un cas réel, quatre couches
    exemptaient chacune un webhook et en oubliaient un second : chaque paiement
    de ce flux mourait avant d'atteindre le code censé l'enregistrer, sans une
    seule erreur journalisée. Le préfixe ET le suffixe ensemble, parce qu'un
    préfixe seul exempterait toute une section de facturation.
  - 30 tests, dont un qui traverse une vraie pile Express avec CSRF et analyseur
    JSON pour vérifier que les octets signés arrivent intacts.

## 2026-08-25 (5)

### Ajoute

- `@astratra/pdf` (`0.1.0`, nouveau package) — primitives de mise en page pour
  PDFKit, en ne gardant que ce qui n'est pas du métier : la connaissance des
  pièges de PDFKit, pas le dessin des reçus et des bulletins. Aucune dépendance
  à l'exécution — le document est passé en argument, PDFKit reste une
  dépendance de pair optionnelle.
  - `fitText(doc, text, width)` — PDFKit ignore `lineBreak: false` dès qu'une
    largeur est fournie (0.18) et son `ellipsis` ne se déclenche jamais ; le
    texte court alors jusqu'au bord et la ligne suivante écrase ce qui était
    dessous. La coupe se fait donc à la main, par dichotomie, et la mesure porte
    sur la HAUTEUR : le replieur de PDFKit accumule la largeur mot à mot et
    casse une ligne qui tient pourtant au point près selon la mesure d'ensemble.
    « Est-ce que ça tient sur une ligne ? » est la seule question dont la
    réponse correspond à ce qui est dessiné, et elle vaut pour toutes les
    versions.
  - `line()` pour une valeur bornée, `blockHeight()` pour une rangée qui doit
    grandir avec son contenu.
  - `drawTable(doc, { columns, rows, x, y, width, bottom })` — l'en-tête se
    redessine sur chaque page, la hauteur d'une rangée suit sa cellule la plus
    haute (`wrap: true`), et une rangée ne chevauche JAMAIS une coupure de page.
    `bottom` réserve la place de ce qui vient après le tableau, sinon un bloc de
    totaux part sur une page à lui seul. Les colonnes sans largeur se partagent
    le reste du cadre.
  - `keepTogether(doc, { y, height })` — un panneau de synthèse ou une ligne de
    signature coupée en deux est pire qu'une coupure de page avant elle.
  - 36 tests, exécutés sur un VRAI document PDFKit : chaque affirmation porte
    sur ce que PDFKit fait des métriques de police, pas sur notre arithmétique.

## 2026-08-25 (4)

### Ajoute

- `@astratra/i18n-server` (`0.1.0`, nouveau package) — traduire ce que le
  SERVEUR renvoie. Les textes d'interface sont traduits côté client, les
  messages d'erreur ne le sont pas : ils reviennent de l'API et s'affichent tels
  quels, donc une application en anglais répond dans la langue du serveur.
  Aucune langue imposée, aucune dépendance à l'exécution.
  - `createMessageCatalog({ languages, defaultLanguage, messages })` — la CLÉ est
    la phrase source elle-même. Aucun identifiant à inventer, aucun appel à
    modifier, et une phrase absente du catalogue revient dans la langue
    d'origine : c'est exactement le comportement d'avant, donc le package
    s'adopte en production et le catalogue se remplit ensuite, sans régression
    entre les deux. `coverage()` dit où en est chaque langue et nomme ce qui
    manque — un catalogue que personne ne mesure cesse d'être rempli.
  - `createLanguageResolver({ languages, read? })` — lit `Accept-Language`, donc
    aucun client n'a à changer ; une préférence enregistrée l'emporte sur celle
    du navigateur. La première langue RECONNUE gagne, même précédée d'une
    inconnue. Renvoie toujours une langue servie, jamais null ni un tag brut.
  - `createTranslationMiddleware({ catalog, resolver, fields? })` — la
    traduction se fait une fois, à la sortie, en enveloppant `res.json`. Les
    contrôleurs ne changent pas. Seuls les champs nommés sont touchés, JAMAIS le
    contenu de `data` : traduire une valeur la corromprait.
  - `createMessageAudit()` et `collectMessages()` — le test qui refuse les mots
    de développeur et les phrases qui n'apprennent rien. Ce n'est pas un
    contrôle de style : il cherche deux échecs précis, et une fois dans la suite
    de tests la règle se défend toute seule. Le vocabulaire banni est
    configurable, `allow` couvre le cas rare où le mot technique est le plus
    clair.
  - 47 tests, aucune dépendance à l'exécution.

## 2026-08-25 (3)

### Ajoute

- `@astratra/entitlements` (`0.1.0`, nouveau package) — plans, fonctionnalités,
  droits d'accès et commission de plateforme. Aucun plan, aucun rôle, aucun
  taux imposé, et zéro dépendance à l'exécution.
  - `createPlanCatalog({ plans, labels, upgradePath, fallbackPlan })` — un seul
    catalogue consulté partout, au lieu d'une liste de fonctionnalités qui
    dérive entre la page tarifs, le garde d'API et l'interface. Un plan inconnu
    retombe sur le PLUS PETIT plan, pas sur le plus généreux : un plan mal
    orthographié doit donner le moins d'accès possible. `overrides` accorde une
    fonctionnalité hors offre à un compte sans la donner à tous.
  - `createFeatureGuard({ catalog, resolveAccount, isExempt?, isEnabled? })` —
    l'interrupteur de maintenance (`isEnabled`) est vérifié AVANT le plan :
    une fonctionnalité coupée l'est aussi pour l'offre qui la paie, et
    répondre « passez à l'offre supérieure » serait un mensonge.
  - `onError` vaut `'deny'` par défaut : une panne de base ne doit pas ouvrir
    les fonctionnalités payantes. `'allow'` reste disponible pour un produit qui
    préfère rester debout plutôt que fermé — mais comme un choix, pas un oubli.
  - `createStatusGuard({ resolveStatus, blockedStatuses })` — le blocage d'un
    compte entier, distinct de l'entitlement : un compte suspendu perd tout
    d'un coup et n'a pas à s'entendre proposer une montée en gamme.
  - `createCommissionSchedule({ defaultRate, rates })` — commission par plan en
    unités mineures ENTIÈRES ; `commission + net` égale toujours le montant.
  - `createAccessMatrix({ screens, superRoles })` et `except(roles, ...)` — un
    écran absent de la table est FERMÉ, jamais ouvert : l'inverse est la façon
    dont un écran part en production visible par tout le monde. `screensFor()`
    donne directement le menu d'un rôle.
  - 53 tests, aucune dépendance à l'exécution.

## 2026-08-25 (2)

### Ajoute

- `@astratra/credentials` (`0.1.0`→`0.2.0`) — rotation du chiffrement. Le
  package savait ranger des clés chiffrées ; il ne savait pas changer le
  chiffrement, ce qui est la panne silencieuse par excellence : remplacer le
  cipher ne lève rien, le coffre attrape l'échec ligne par ligne, retombe sur le
  `.env`, et toutes les clés cessent d'être utilisées sans le moindre message.
  Ajouté après avoir rencontré exactement ce trou.
  - `createCredentialVault({ previousCipher })` — le coffre lit les DEUX
    générations le temps d'une rotation. Les écritures utilisent toujours le
    cipher courant : c'est ce qui fait converger la migration au lieu de la
    faire osciller. `vault.isRotating()` dit si un repli est en place.
  - `createCredentialRotation({ store, catalog, from, to })` — `plan()` simule
    sans rien écrire, `apply()` migre, `isComplete()` répond à la seule question
    qui compte à la fin : peut-on retirer l'ancien cipher ? Non tant qu'il reste
    quelque chose à migrer OU une valeur qu'aucun des deux ne lit — celle-là est
    déjà perdue, et retirer l'ancien cipher rendrait la perte définitive.
    `unreadableKeys` nomme lesquelles regarder.
  - Le nouveau cipher est essayé EN PREMIER : une valeur déjà migrée est
    reconnue au lieu d'être signalée illisible, donc un passage interrompu se
    relance sans rien abîmer.
  - Un marqueur de débranchement et une valeur déclarée `secret: false` ne sont
    jamais réécrits : l'un deviendrait illisible au lieu de rester débranché,
    l'autre doit rester lisible dans l'interface.
  - 106 tests (88 → 106).

## 2026-08-25

### Ajoute

- `@astratra/credentials` (`0.1.0`, nouveau package) — les clés de service
  (paiement, e-mail, IA) rangées chiffrées dans la base plutôt que dans un
  `.env`, éditables depuis l'interface et effectives sans redémarrage. Extrait
  aucun catalogue de fournisseurs intégré, aucun chiffrement imposé, aucune
  base imposée.
  - `createCredentialCatalog({ spaces, reservedKeys })` — la liste explicite des
    clés que l'interface pilote. Jamais un champ libre : sans catalogue,
    n'importe quel nom de variable pourrait être écrit en base puis lu au
    démarrage. `reservedKeys` refuse celles qui protègent les autres
    (`ENCRYPTION_KEY`, `JWT_SECRET`, `MONGODB_URI`...).
  - `createCredentialVault({ store, catalog, cipher, guard?, onChange? })` —
    base d'abord, `.env` ensuite, `null` si débranchée. Le marqueur de
    débranchement distingue « retirée volontairement » de « jamais saisie » :
    sans lui, la variable d'environnement de secours ferait réapparaître une clé
    qu'on croit débranchée. Ne lève jamais à la lecture — pas de base, cipher
    absent, valeur abîmée : on retombe sur le `.env`, et une clé illisible
    n'emporte pas les autres. `status()` ne renvoie jamais un secret, seulement
    les quatre derniers caractères.
  - `createValueGuard({ keys, decidingKey, livePattern, testPattern })` — le
    poste local et la production partagent souvent le même store ; la règle
    porte sur la VALEUR, pas seulement sur l'environnement. Une valeur réelle ne
    quitte pas la production, une valeur de test circule partout, une valeur non
    classable n'est jamais traitée comme réelle. `decidingKey` fait suivre au
    groupe le sort de la clé qui le classe (une signature de webhook ne dit rien
    d'elle-même mais appartient au même compte que la clé secrète). Permissif
    par défaut : Astratra n'a pas d'avis sur les clés qui déplacent de l'argent.
  - `createEnvHydrator({ vault, guard? })` — remplit et maintient `process.env`
    pour tout le code qui lit ses secrets de façon synchrone. Trois cas, dont
    celui qu'on oublie : une clé retirée de la base restaure la valeur D'ORIGINE
    du `.env`, capturée une seule fois au premier appel. Sans lui, l'ancienne
    valeur resterait figée jusqu'au prochain redémarrage — un service qu'on
    croit débranché et qui continue de fonctionner.
  - `createUnlockChallenge({ store, deliverCode })` — code à usage unique avant
    toute modification : savoir le mot de passe ne suffit pas. Six chiffres via
    `crypto.randomInt`, comparaison à durée constante, jamais conservé en clair,
    cinq tentatives, et demander un nouveau code referme la fenêtre en cours.
    L'envoi est injecté — le package ne connaît pas l'e-mail.
  - `createCredentialsRoutes({ vault, challenge?, authorize })` — routeur Express
    complet. `authorize` obligatoire : ces clés engagent les paiements de toute
    la plateforme, et Astratra ne décide pas qui possède l'argent.
  - Adapters fournis : `createMemoryCredentialStore` / `createMemoryChallengeStore`
    (tests, développement) et `createMongoCredentialStore` /
    `createMongoChallengeStore` (n'importe quelle collection du driver MongoDB,
    sans mongoose ni schéma). `isReady` évite qu'une lecture reste suspendue dans
    la file d'attente de mongoose au lieu de retomber sur le `.env`.
  - 88 tests. Aucun autre package n'a besoin de bump : `@astratra/credentials`
    dépend de `@astratra/core` et n'est référencé par aucun.

### Change

- `eslint.config.js` — `setInterval`/`clearInterval` ajoutés aux globals Node
  partagés, aux côtés de `setTimeout`/`clearTimeout` déjà présents.
- `scripts/verify-package-installation.js` — `@astratra/credentials` ajouté à la
  vérification d'installation des archives.

## 2026-08-20 (2)

### Ajoute

- `@astratra/security` (`1.7.0`→`1.8.0`) — `createRandomCode({ prefix?, tokenBytes? })` /
  `generateUniqueCodes({ quantity, prefix?, isTaken?, maxAttempts? })` :
  génération de codes à usage unique via `crypto.randomBytes` (code promo,
  invitation, carte cadeau...). `generateUniqueCodes` vérifie l'unicité
  contre le store fourni par l'appelant (`isTaken`) AVANT de renvoyer quoi
  que ce soit, jamais après une tentative d'insertion — aucun risque de
  double insertion partielle sur un nouvel essai (boucle de retry ajoutée
  après examen du risque de collision). `@astratra/saas-kit`
  n'a pas besoin de bump : sa dépendance `^1.7.0` couvre déjà `1.8.0`.

## 2026-08-20

### Ajoute

- `@astratra/security` (`1.6.0`→`1.7.0`) — `createRedisRateLimitStore({ redisUrl, prefix? })` :
  construit un store `express-rate-limit` Redis avec un préfixe de clés
  librement choisi par le projet consommateur, pour isoler les compteurs de
  plusieurs limiteurs (connexion, réservation, avis...) sur une même
  instance Redis. Garde la bascule automatique vers un store en mémoire déjà
  présente dans `createApiLimiter`/`createLoginLimiter` si Redis est
  indisponible ou perd la connexion. Aucun nom de domaine métier dans
  Astratra — le préfixe est entièrement défini par l'appelant.
- `@astratra/saas-kit` (`1.5.0`→`1.5.1`, dépendance `@astratra/security`
  resserrée à `^1.7.0`) — aucun changement de comportement propre ; `store`
  était déjà relayé tel quel à `apiRateLimit`/`loginRateLimit`, donc
  `createRedisRateLimitStore` (ci-dessus) s'y branche sans modification de
  code, seule la doc README a été complétée avec un exemple.

## 2026-08-18

### Ajoute

- `@astratra/security` (`1.5.0`→`1.6.0`) — deux primitives qu'aucun projet
  consommateur n'avait à l'origine :
  - `isStrongPassword(password, options?)` — `hashPassword` existait déjà,
    mais rien ne jugeait si un mot de passe valait la peine d'être haché ;
    chaque projet devait écrire sa propre vérification, sans partage
    possible entre projets Astratra. 8 caractères + majuscule + minuscule +
    chiffre + caractère spécial par défaut, chaque catégorie
    individuellement désactivable, pas de message imposé (chaque app garde
    la main sur son propre texte/langue).
  - `createMongoSanitizeMiddleware(options?)` — retire les clés `$...`
    (opérateurs Mongo) et les clés à point (`"a.b"`) de
    `req.body`/`req.query`/`req.params` avant qu'une route ne les transmette
    à un filtre de base de données. Trouvé en construisant un projet
    consommateur réel : une route passait `req.query.date` tel quel dans un
    filtre Mongoose, et `?date[$gt]=` (notation crochet du parseur `qs`
    d'Express) devenait un opérateur Mongo choisi par l'appelant au lieu
    d'une simple chaîne — une injection NoSQL sur une route publique, non
    authentifiée. Mute les objets en place (jamais de réassignation de
    `req.query`, getter seul sur certaines configurations Express/routeur).
- `@astratra/saas-kit` (`1.4.1`→`1.5.0`, dépendance `@astratra/security`
  resserrée à `^1.6.0`) —
  - `createMongoSanitizeMiddleware` (ci-dessus) est désormais monté par
    défaut dans `createSaasApp()`, comme la CSP et les en-têtes de
    sécurité — protège aussi les routes ajoutées via `extendRoutes`, pas
    seulement les routes intégrées du kit. Désactivable via
    `mongoSanitize: false`.
  - Nouvelle option `trustProxy`, relayée à `app.set('trust proxy', ...)`.
    Non définie par défaut (comportement Express inchangé). Trouvé sur le
    même projet consommateur, déployé derrière nginx en production : sans
    ça, Express ignore `X-Forwarded-For` et voit l'IP du proxy pour tous
    les visiteurs — `apiRateLimit`/`loginRateLimit` traitaient alors tout
    le trafic du site comme un seul client, invisible en dev (pas de proxy
    là pour révéler le problème), découvert via le monitoring d'erreurs en
    prod.

## 2026-08-15

### Ajoute

- `@astratra/react` (`0.1.1`→`0.2.0`) — `createApiFetch` attache maintenant
  lui-même le jeton CSRF (cookie `astratra_csrf` → header `x-csrf-token`,
  mêmes noms que `@astratra/security` par défaut) sur toute requête mutante.
  Avant, chaque projet consommateur devait réécrire le même enrobage à la
  main — trouvé en construisant un projet réel qui l'avait fait deux fois
  indépendamment. N'écrase jamais un header explicite ; désactivable via
  `csrf: false` ; noms de cookie/header personnalisables.
- `@astratra/tooling` (`1.0.1`→`1.1.0`) — nouvelle commande
  `astratra audit:deps [--severity=<level>]` : relaie `npm audit --json` et
  échoue (exit code non-zéro, exploitable en CI) si une dépendance a une CVE
  au-dessus du seuil configuré (`moderate` par défaut). Ne réimplémente pas
  la détection — seulement le filtrage par sévérité et un format cohérent
  avec les autres commandes `audit:*`. Trouvé en manquant deux CVE modérées
  sur `react-router-dom` dans un projet consommateur avant de penser à lancer
  `npm audit` à la main.
- `@astratra/security` (`1.4.0`→`1.5.0`) — `createAuthMiddleware` détecte
  maintenant le cas où `req.cookies` est `undefined` **et** qu'aucun jeton
  n'a été trouvé par ailleurs (header `Authorization` compris) : au lieu
  d'un 401 silencieux indiscernable d'une vraie absence de session, il
  transmet une `AuthConfigurationError` explicite à `next(error)`. Trouvé
  en construisant un projet consommateur réel qui montait son propre
  routeur avant `createSaasApp()` sans `cookieParserMiddleware()` — l'auth
  échouait sans aucun indice sur la cause. Le garde-fou ne se déclenche
  jamais pour un flux 100% `Authorization: Bearer` (les cookies ne sont
  regardés qu'en dernier recours). Nouveau : `docs/guides/custom-routes-wiring.md`,
  qui documente le pattern `extendRoutes` recommandé et pourquoi un
  routeur monté en parallèle doit reconstruire cookies + CSRF à la main.
- `@astratra/saas-kit` (`1.4.0`→`1.4.1`) — aucun changement de code, mais
  `createSaasApp()` utilise `createAuthMiddleware` en interne : le
  comportement décrit ci-dessus (erreur explicite au lieu d'un 401 masqué)
  s'applique donc aussi à toute app construite sur le kit. Plancher
  `@astratra/security` relevé à `^1.5.0` en conséquence.
- `@astratra/security` (`1.3.0`→`1.4.0`) :
  - `hashPassword(password)` / `verifyPasswordHash(password, hash)` —
    scrypt (natif à Node, aucune dépendance bcrypt/argon2 ajoutée), sel
    aléatoire par hash, comparaison à temps constant. `verifyPassword`
    reste un callback fourni par l'app ; avant, aucune primitive de hachage
    n'existait, rien n'empêchait un `===` en clair.
  - `createSecurityHeadersMiddleware()` — `X-Frame-Options`,
    `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, et
    `Strict-Transport-Security` (actif automatiquement seulement en
    production). Seul CSP était couvert avant ; ce set standard manquait
    entièrement.
  - `createSecurityAuditLogger()` — journalise une ligne structurée pour
    toute requête qui se termine en `401`/`403`/`429` (configurable),
    peu importe quelle couche (CSRF, WAF, rate limit, JWT) l'a produite.
    Avant, aucune de ces couches ne journalisait quoi que ce soit : une
    tentative d'attaque restait invisible tant qu'elle n'avait pas réussi.
- `@astratra/saas-kit` (`1.3.0`→`1.4.0`) — `createSaasApp()` monte
  désormais `createSecurityHeadersMiddleware` et `createSecurityAuditLogger`
  sans condition (comme CSP), au même titre que les couches déjà actives
  par défaut. `options.securityHeaders` personnalise les en-têtes ;
  `options.securityAudit: false` désactive le journal, un objet ou `true`
  le personnalise (sink de log personnalisé, codes de statut surveillés).
  Plancher `@astratra/security` relevé à `^1.4.0` en conséquence.

## 2026-08-14

### Corrige

- `@astratra/saas-kit` (`1.1.1`→`1.2.0`) — **les routes ajoutées après
  `createSaasApp()` étaient silencieusement inatteignables.**
  `createSaasApp()` termine sa propre pile de middlewares par un
  `notFoundMiddleware`/`errorMiddleware` avant de retourner l'app ; toute
  route enregistrée ensuite par l'appelant (`app.get(...)` sur l'objet
  retourné) tombait donc systématiquement sur ce 404 interne. Ajoute
  `options.extendRoutes(app, { authMiddleware, csrfMiddleware,
  authorizeAdmin, authorizeRoles })`, exécuté avant le 404 — c'est
  désormais la façon documentée d'ajouter ses propres routes. L'app
  retournée expose aussi directement `app.authMiddleware`,
  `app.csrfMiddleware` et `app.authorizeAdmin` pour éviter d'en reconstruire
  des doublons divergents.
- `@astratra/saas-kit` / `@astratra/security` (`1.1.1`→`1.2.0`) — **le
  cookie CSRF n'était jamais amorcé par `GET /auth/me`**, le point d'entrée
  naturel d'une session (utilisé par `getSession` de `@astratra/react`).
  Seuls `/auth/logout` et `/auth/logout-all` montaient `csrfMiddleware`
  parmi les routes `/auth`. Une route métier qui ne monte
  `csrfMiddleware` que sur ses handlers mutants (le réflexe naturel)
  finissait par émettre le cookie CSRF dans la même réponse que la requête
  censée le valider — un 403 `Invalid CSRF token` permanent, puisque le
  client n'avait jamais pu lire le cookie à temps. `@astratra/security`
  ajoute `createCsrfCookiePrimer()` : amorce le cookie sur toute requête
  sûre (GET/HEAD/OPTIONS) sans jamais valider de token. `createSaasApp()`
  le monte désormais globalement, avant toutes les routes — y compris
  celles ajoutées via `extendRoutes`. `createCsrfMiddleware()` et le primer
  vérifient aussi les cookies déjà mis en file sur la même réponse avant
  d'en émettre un nouveau, pour rester idempotents quand les deux
  s'exécutent sur une même requête.
- `create-astratra-app` (`1.0.2`→`1.1.0`) — le template généré n'illustrait
  nulle part comment ajouter une route métier, alors que c'est le tout
  premier geste de quiconque démarre un projet avec le starter.
  `api/server.js` montre maintenant `extendRoutes` avec un exemple concret
  (`GET /api/status`, branché sur l'outil `health_check` d'`api/ai/tools.js`
  — jusque-là scaffoldé mais jamais câblé). `@astratra/store-mongo` et
  `mongoose` passent de `dependencies` à `optionalDependencies` dans le
  `package.json` généré : ils sont scaffoldés (`api/stores/mongo.js`,
  `api/db/mongo.js`) mais pas utilisés par défaut (le projet démarre sur le
  store mémoire), donc plus besoin d'installer un driver Mongo avant d'avoir
  choisi de s'en servir.

### Ajoute

- `@astratra/security` (`1.2.0`→`1.3.0`) — `createCorsMiddleware(options)`.
  Astratra n'a jamais imposé de politique CORS fixe (les origines
  autorisées sont spécifiques à chaque projet) mais ne fournissait aucune
  primitive non plus, poussant chaque consommateur — y compris le template
  `create-astratra-app` lui-même — à réimplémenter sa propre version. C'est
  cette même logique, déjà éprouvée, qui est promue en primitive partagée.
  Origines `127.0.0.1`/`localhost` autorisées par défaut hors production,
  `credentials` activé par défaut (sessions cookie), `OPTIONS` court-circuité
  en 204.
- `@astratra/saas-kit` (`1.2.0`→`1.3.0`) — `options.cors`, monté tout premier
  dans la pile de `createSaasApp()`, avant absolument tout le reste — y
  compris les routes ajoutées via `extendRoutes`. Élimine le piège classique
  où un `app.use(cors())` ajouté après coup sur l'app retournée ne s'applique
  jamais aux routes déjà montées en interne (`/auth`, etc.). Omis, rien ne
  change.
- `create-astratra-app` (`1.1.0`→`1.2.0`) — le template généré utilise
  désormais `createSaasApp({ cors: {...} })` au lieu d'envelopper l'app dans
  un `express()` externe avec un middleware CORS maison
  (`api/config/cors.js`, supprimé). Planchers `@astratra/saas-kit` et
  `@astratra/security` relevés à `^1.3.0` en conséquence ; `express` retiré
  des dépendances directes du projet généré (n'y était plus utilisé
  directement, disponible en transitif via `saas-kit`).
- `@astratra/security` (`1.3.0`→`1.4.0`) — `createMemoryWebauthnStore()`,
  implémentation de référence en mémoire du contrat `WebauthnStore`, même
  motif que `createMemoryUsersStore`/`createMemorySettingsStore` : avant,
  aucun store WebAuthn par défaut n'existait, il fallait en écrire un avant
  de pouvoir simplement essayer le flux. Credentials perdues au redémarrage
  — à remplacer par une vraie base avant la prod. Ajoute aussi
  `createFieldCipher(options)` / `generateFieldEncryptionKey()` : chiffrement
  de champ AES-256-GCM authentifié pour les valeurs qu'une app écrit
  elle-même dans son store — Astratra ne s'intercale jamais entre l'app et
  sa base, donc rien en amont ne pouvait chiffrer les données à sa place.
- `@astratra/ai` (`1.0.2`→`1.1.0`) — `runAgentLoop` accepte deux nouveaux
  callbacks optionnels, tous deux sans effet si omis. `onChunk(chunk)` :
  appelé pour chaque morceau reçu quand `router.ask()` retourne un flux —
  avant, `stringifyModelResponse` consommait le flux en entier avant de
  rendre la main, aucun streaming token par token n'atteignait l'appelant
  même si le provider le supportait. `confirmTool(toolCall, ctx)` : attendu
  avant l'exécution d'un appel d'outil détecté ; retourner `false` annule
  l'exécution sans faire planter la boucle (le modèle reçoit
  `{"denied": true}` comme résultat et peut réagir) — avant, chaque appel
  d'outil autorisé par le rôle s'exécutait automatiquement, sans point
  d'arrêt possible pour une confirmation humaine.
- `@astratra/store-mongo` (`1.0.2`→`1.1.0`) et `@astratra/store-postgres`
  (`1.0.2`→`1.1.0`) — `createMongoMigrationRunner`/
  `createPostgresMigrationRunner` : un runner minimal, pas un DSL ni une
  CLI — étant donné un tableau `{ id, up(client) }`, applique une seule fois
  chaque migration non encore vue, dans l'ordre, suivi par `id` dans une
  table/collection dédiée. La variante Postgres enveloppe chaque migration
  dans sa propre transaction (annulée en cas d'échec) ; la variante Mongo
  ne le fait pas (pas de transactions inter-collections sur un déploiement
  standalone) — voir les README respectifs. Avant, aucun outil de ce type
  n'existait dans le framework : faire évoluer un schéma en prod restait
  entièrement manuel.

## 2026-08-09

### Modifie

- Tous les packages publics (`@astratra/ai` `1.0.1`→`1.0.2`, `@astratra/core`
  `1.0.0`→`1.0.1`, `create-astratra-app` `1.0.1`→`1.0.2`,
  `@astratra/prerender` `0.1.0`→`0.1.1`, `@astratra/react` `0.1.0`→`0.1.1`,
  `@astratra/saas-kit` `1.1.0`→`1.1.1`, `@astratra/saas-kit-ui`
  `1.0.0`→`1.0.1`, `@astratra/security` `1.1.0`→`1.1.1`,
  `@astratra/store-mongo`/`store-postgres` `1.0.1`→`1.0.2`,
  `@astratra/tooling` `1.0.0`→`1.0.1`) déclarent maintenant `engines.node
  ">=20"`, aligné sur la matrice CI. Sans ça, un `npm install` sous Node < 20
  ne loguait un problème qu'à l'exécution, pas à l'installation.
- `@astratra/saas-kit-ui` et `@astratra/react` documentent maintenant
  explicitement leur différence : `saas-kit-ui` reste dashboard complet +
  JWT en mémoire (`Authorization: Bearer`), `@astratra/react` reste
  primitives nues + session cookie `HttpOnly`, sans dashboard imposé — ce
  n'était pas documenté et pouvait passer pour un doublon accidentel entre
  les deux packages.

### Ajoute

- `@astratra/prerender` (`0.1.0`) — première version. Prérendu SEO générique
  pour un site Vite + React : `prerender()` et le binaire `astratra-prerender`
  génèrent un `index.html` par route (Playwright + `vite preview`), préservent
  `dist/_shell.html` vierge pour les visiteurs humains, et exposent
  `transformHtml(html, context)` / `isReady(page, route)` pour l'adaptation par
  projet. `audit.js` vérifie titre et description présents, détecte les titres
  et le contenu visible dupliqués entre pages, et avertit sans bloquer sur un
  contenu trop mince. Couvert par un test d'intégration bout-en-bout (vrai
  Vite, vrai Chromium, 14 cas), en plus des tests unitaires des fonctions pures.
- `@astratra/security` (`1.0.2` → `1.1.0`) — sessions cookie `HttpOnly`
  intégrées : `setSessionCookie`/`clearSessionCookie` (`HttpOnly` toujours,
  `Secure` par défaut sauf `NODE_ENV=development`, `SameSite` configurable),
  `cookieParserMiddleware()` pour peupler `req.cookies` sans dépendance
  `cookie-parser`, et `createCsrfMiddleware()` (double-submit cookie/header,
  bypass automatique pour les clients authentifiés par `Authorization:
  Bearer`). Révocation JWT ajoutée : `createMemoryRevocationStore()` avec
  `revoke`/`isRevoked` (par `jti`, un token précis) et
  `revokeAllForUser`/`isRevokedForUser` (par utilisateur et `iat`, pour un
  logout de tous les appareils). `createAuthMiddleware({ revocationStore })`
  dérive automatiquement `verifySession` si aucun n'est fourni explicitement.
  Tous les nouveaux exports typés dans `index.d.ts` et exercés dans
  `typecheck.ts`.
- `@astratra/saas-kit` (`1.0.2` → `1.1.0`) — `createSaasApp` monte désormais
  `cookieParserMiddleware()` et un `revocationStore` mémoire par défaut,
  branche le CSRF sur toutes les routes mutantes protégées, et ajoute
  `POST /auth/logout` (invalide le token courant) et `POST /auth/logout-all`
  (invalide tous les tokens actifs de l'utilisateur). Dépendance sur
  `@astratra/security` resserrée à `^1.1.0`.
- `@astratra/react` (`0.1.0`) — première version. Primitives React
  optionnelles (`SessionProvider`, `useSession`, `useUser`,
  `usePermissions`, `RequireAuth`, `RequireRole`, `createApiFetch`) pour
  consommer une session cookie `HttpOnly` côté client sans imposer
  d'endpoint, de routing ni de configuration CSRF — ça reste la
  responsabilité de l'application consommatrice. Testé avec
  `@testing-library/react` sur un DOM `jsdom` monté pour `node --test`.

### Corrige

- `@astratra/saas-kit` (`1.0.2` → `1.1.0`) — le cookie de session posé au
  login n'était jamais relu par le middleware d'authentification :
  `createSaasApp` ne montait aucun cookie-parser (`req.cookies` restait
  `undefined`) et le nom de cookie par défaut attendu par `jwtAuth.js`
  (`token`) ne correspondait pas au nom réellement posé
  (`astratra_session`). Un client web se connectant et rappelant une route
  protégée avec uniquement ce cookie recevait `401` au lieu de `200`.
  Confirmé par test de mutation avant correctif (rejeu du cookie posé au
  login contre une route protégée), pas trouvé par simple lecture de code.
- `@astratra/saas-kit` (`1.1.0`) — `POST /auth/logout-all` plantait en `500`
  si un `revocationStore` personnalisé n'implémentait pas la méthode
  optionnelle `revokeAllForUser` (marquée `?` dans l'interface
  `RevocationStore`). Dégrade maintenant proprement (`200`, logout-all
  no-op) quand la méthode est absente. Trouvé par mutation avec un store
  minimal ne fournissant que `revoke`/`isRevoked`.
- `@astratra/security` (`1.0.1` → `1.0.2`) — `createWafMiddleware()` avertit
  désormais (une seule fois par instance, via le logger de `@astratra/core`)
  quand `req.body` vaut `undefined` au moment de son exécution. Monté avant
  `express.json()`, ce middleware inspectait silencieusement une chaîne vide
  à la place du corps réel de la requête : un payload SQLi/XSS dans le body
  passait sans être bloqué, sans la moindre erreur pour le signaler. Trouvé
  en testant manuellement une injection réelle sur une app consommatrice, pas
  par les tests existants — aucun n'exerçait ce cas. README mis à jour avec
  l'ordre de montage requis.
- `@astratra/security` (`1.0.1` → `1.0.2`) — même défaut trouvé et corrigé
  dans `createAccountLimiter()` : sa clé de compte par défaut lit aussi
  `req.body.email`. Monté avant `express.json()`, toutes les tentatives de
  connexion retombaient sur la clé partagée `"unknown"` — plus de limite par
  compte, une seule limite globale partagée par tous les comptes (bypass
  partiel de la protection anti brute-force, et risque de blocage
  d'utilisateurs sans rapport entre eux). Même avertissement une seule fois,
  README mis à jour. Trouvé en auditant systématiquement les autres
  middlewares du package après le premier correctif, pas par hasard.
- `@astratra/saas-kit` — sa dépendance sur `@astratra/security` resserrée de
  `^1.0.1` à `^1.0.2`, pour qu'une installation fraîche ne puisse plus jamais
  résoudre la version vulnérable (`^1.0.1` la couvrait déjà implicitement,
  mais sans l'exiger explicitement). Aucun changement de code dans
  `saas-kit` lui-même — il montait déjà `express.json()` avant le WAF
  correctement.

## [1.0.0] - 2026-08-08

Première version à API publique stable pour les fondations SaaS Astratra.
Cette v1 stabilise les contrats des packages publiables et ajoute
`@astratra/store-postgres` comme second adapter de persistance réel.

Cette version ne promet pas une application finale complète ni une sécurité
garantie : elle fournit une base technique réutilisable, testée et extensible.

### Ajoute

- `@astratra/store-postgres` — adapters PostgreSQL/`pg` pour les contrats
  `usersStore` et `settingsStore`, même contrat que `@astratra/store-mongo`,
  moteur différent. Tests via `pg-mem`, aucune instance Postgres externe
  requise.
- `@astratra/security` — CSP configurable (`createCspMiddleware`), montée
  par défaut dans `createSaasApp` avec une politique `default-src 'none'`
  adaptée à une API JSON.
- `@astratra/saas-kit` — validation d'entrée réelle (`express-validator` +
  `validateMiddleware`) sur `/auth/login`, `POST /users`,
  `PATCH /settings/:key` et `POST /notifications/send`.

### Modifie

- Toutes les versions de packages passent de `0.1.x` à `1.0.0`, y compris
  les plages de dépendances internes (`^0.1.0` -> `^1.0.0`).
- `create-astratra-app` génère désormais des projets qui dépendent des
  packages Astratra en `^1.0.0`.

## [0.1.0] - 2026-08-08

V0 initiale publique des packages Astratra.

### Ajoute

- `@astratra/core` — format de réponse API, gestion d'erreurs, logs,
  request IDs, validation, chargement d'environnement.
- `@astratra/tooling` — CLI `astratra` : `audit:secrets`, `audit:routes`,
  `audit:i18n`, `test`, `deploy`.
- `@astratra/security` — auth JWT avec révocation de session injectée,
  RBAC, rate limiters configurables, WAF, WebAuthn/passkeys avec store de
  credentials injecté.
- `@astratra/ai` — routeur IA multi-provider générique (quotas, cooldown,
  dégradation, état partagé Redis optionnel), registre d'outils, boucle
  minimale d'agent avec appels d'outils.
- `@astratra/saas-kit` — starter `createSaasApp()` assemblant auth, users,
  settings, notifications et résumé dashboard depuis des adapters injectés.
- `@astratra/store-mongo` — adapters MongoDB/Mongoose pour les contrats
  `usersStore` et `settingsStore` utilisés par `@astratra/saas-kit`.
- `@astratra/saas-kit-ui` — dashboard React réutilisable pour démarrer une
  interface SaaS au-dessus de `@astratra/saas-kit`.
- `create-astratra-app` — générateur CLI pour créer une app Astratra avec une
  commande.
- `examples/dashboard-ui` — exemple React + Vite couvrant connexion,
  dashboard, users et settings via `@astratra/saas-kit-ui`.
- CI (`.github/workflows/ci.yml`) exécutant la suite complète sur Node
  20.x/22.x à chaque push et pull request, plus le build du dashboard UI.
- `LICENSE` MIT à la racine et dans chaque package publiable.

### Limites connues

Voir "Limites connues" dans [README.md](README.md) : le dashboard UI de repo
reste un exemple, MongoDB/Mongoose est le seul adapter de persistance réel, le
store de credentials WebAuthn reste une interface, et la boucle d'agent n'a pas
encore de streaming/vision/validation humaine.
