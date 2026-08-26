# @astratra/native — Design

Date: 2026-08-26
État : livré (packages, générateur, documentation), vérifié sur simulateur iOS
et émulateur Android contre une API générée.

## Contexte

Les applications clientes arrivent avec leur programme, une par une. Chacune
redemande les mêmes briques : se connecter, garder la session en lieu sûr,
déverrouiller par biométrie, recevoir une notification, revenir d'une page de
paiement. Ces briques existent, écrites et éprouvées, dans `scolaris-mobile`
— mêlées au métier scolaire.

Ce travail les sort de là, sans le métier, pour qu'un projet client parte d'un
socle plutôt que d'une page blanche.

## Objectif

Trois pièces, dans cet ordre de dépendance.

### `@astratra/native` (nouveau)

La logique mobile, **sans Expo au runtime**. Le package ne charge ni
`expo-secure-store`, ni `expo-notifications`, ni `expo-web-browser` : il reçoit
ces modules en adaptateurs. Même règle que `@astratra/notify` avec son
transport, et même bénéfice — le package se teste avec Jest en Node, sans
simulateur ni build natif.

Contenu :

- **session** : stockage sécurisé (contrat SecureStore, repli navigateur),
  jetons d'accès et de rafraîchissement, garde biométrique ;
- **push** : service de notifications natives, veille au premier plan,
  politique de canaux, état d'autorisation ;
- **écran** : natif iOS ou repli pour l'effet de verre ;
- **navigateur** : ouvrir un paiement et revenir dans l'application.

### `@astratra/client` (existant, complété)

Le refresh 401 à vol unique, la garde de route à liste publique, les règles de
mot de passe et la file hors ligne y sont déjà. On y ajoute ce que le mobile
avait en plus, sans dupliquer : évaluation du mot de passe condition par
condition, lecture d'incidents, formulaire de profil, lecteur d'état des clés
de service, lien de support pré-rempli, rafraîchissement au retour au premier
plan.

### `create-astratra-app --template mobile` (nouveau)

Squelette Expo Router copié depuis un répertoire `templates/mobile/`, pas
écrit en chaînes JS inline : une app Expo compte trop de fichiers pour la
méthode actuelle du générateur.

Il câble les deux packages ci-dessus et pointe vers l'API du template
`fullstack`, pour qu'un client reçoive API, web et mobile d'une même commande.

## Périmètre

Lot 1 — retenu : les modules déjà génériques, plus le noyau de transport
d'`apiClient` (lignes 1 à 730 : erreurs typées, rafraîchissement, MFA e-mail,
téléversement, téléchargement, flux SSE).

Lot 2 — différé : les ~2 900 lignes à réécrire en injection de dépendances
(catalogue d'outils par rôle, abonnements, documents, agrégat d'aperçu,
messagerie, alertes). Chaque brique sort quand un programme client la réclame.

Hors périmètre définitif : le métier scolaire — scolarité, trésorerie, frais,
bulletins, présences, pédagogie, quiz, tableau de bord famille, réseau QG.

## Conventions

Celles du dépôt, sans exception : CommonJS, source commentée en anglais,
README en français, `src/index.d.ts` avec son `typecheck.ts`, tests Jest dans
`__tests__`, aucune dépendance runtime.
