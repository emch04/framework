# Jetons de rafraîchissement — Design

Date: 2026-08-26

## Contexte

`createSaasApp()` délivrait un jeton d'accès d'une heure et rien d'autre. Sur
un site web, c'est tenable : la session vit dans un cookie `HttpOnly` et
l'utilisateur reste devant son écran. Sur un téléphone, l'application est
rouverte trois jours plus tard — et redemande le mot de passe, à chaque fois.

Le gabarit mobile appelait déjà `/auth/refresh`. La route n'existait pas.

## Objectif

Permettre à une session de durer sans transformer un risque d'une heure en
risque d'un mois, et sans changer le comportement des consommateurs actuels.

## Décisions validées avec l'utilisateur

**Faire le travail complet plutôt que d'adapter le client.** Deux options
avaient été posées : retirer le rafraîchissement de l'application mobile (une
heure de travail), ou l'ajouter au serveur (un chantier). Choix explicite de la
seconde — « jamais le choix à moitié ».

**Un rejeu révoque toute la famille.** Question posée explicitement, réponse
retenue parmi trois : refuser le seul jeton rejoué laisserait le voleur avec le
jeton EN COURS. C'est la règle standard d'OAuth, et elle coûte une reconnexion
à la vraie personne — le prix correct d'une session volée.

## Conception

**Le jeton n'est pas un JWT.** Chaîne aléatoire opaque, sans information, qui
n'a de sens que comme ligne d'un magasin. C'est ce qui le rend **révocable** :
un jeton signé reste valable jusqu'à son expiration, quoi qu'on en pense.

**Il est rangé en empreinte (SHA-256), jamais en clair.** Une base volée ne
donne aucune session. Le jeton a toute l'entropie voulue : rien à casser par
force brute, et un hachage lent à chaque renouvellement ne serait qu'une
surface de déni de service.

**Il tourne à chaque usage.** Le jeton présenté est consommé, un neuf le
remplace. Un jeton vu deux fois devient donc une anomalie détectable — c'est
tout l'intérêt.

**L'expiration repart de maintenant à chaque rotation.** Une session active ne
doit pas mourir parce qu'elle a été ouverte il y a un mois.

**Éteint par défaut** (`refreshTokens: { enabled: false }`). Un identifiant à
longue vie se donne parce qu'un produit en a besoin, jamais parce qu'un défaut
l'a décidé. Éteint, la route `/auth/refresh` n'existe pas.

**L'identifiant de famille voyage dans le jeton d'accès** (`rfid`), pour que la
déconnexion révoque la chaîne sans que le client ait à rendre son jeton de
rafraîchissement.

## Défaut trouvé en exécutant

Les jetons étaient d'abord en base64url, alphabet qui contient `-`. Environ un
jeton sur cent trente portait un `--`, que le WAF de `@astratra/security` lit
comme un commentaire SQL et bloque en 403. La session concernée ne pouvait
alors **plus jamais** être renouvelée : le client rejoue le même jeton et se
fait bloquer à chaque fois. Déconnexion en apparence aléatoire, irreproductible
en support.

Le test de bout en bout échouait deux fois sur six. Une sonde de 400 tirages a
isolé la cause en montrant les jetons fautifs, tous porteurs d'un `--`.

Correction : hexadécimal, pour les jetons de rafraîchissement et de
réinitialisation de mot de passe, qui avaient le même défaut. Deux tests figent
l'alphabet.

**Règle générale retenue : un identifiant ne doit jamais pouvoir être lu comme
du contenu.**

## Livré avec

- `/auth/forgot-password` et `/auth/reset-password`, montées seulement si un
  expéditeur d'e-mail est fourni. La réponse est identique que l'adresse existe
  ou non — sinon l'écran devient un annuaire de comptes. La réinitialisation
  révoque **toutes** les sessions : la personne reprend peut-être un compte
  volé.
- `/notifications/devices`, déclarées avant le garde d'administration du module
  et bornées à `req.user.id` : enregistrer son propre téléphone n'est pas un
  acte d'administration, et un identifiant d'installation se devine.

## Versions

`@astratra/security` 1.9.1 → 1.10.0, `@astratra/saas-kit` 1.5.1 → 1.6.0
(plancher `@astratra/security` relevé à `^1.10.0`).
