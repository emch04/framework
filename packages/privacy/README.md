# @astratra/privacy

Droit d'accès, droit à l'oubli, suppression de compte en libre-service, et
filtre de données sensibles. Sans détruire les dossiers que tu as l'obligation
de garder.

Aucune dépendance à l'exécution. Rien n'est stocké ni sauvegardé à ta place.

## L'idée centrale : anonymiser, pas supprimer

Supprimer la ligne est le geste évident, et presque toujours le mauvais.

Les notes d'un élève, les factures d'un client, les fiches de paie d'un salarié
ont leur propre durée de conservation légale, et appartiennent à
l'établissement, à l'entreprise, au fisc autant qu'à la personne. Supprimer le
compte les emporte avec lui, ou les laisse orphelines et inexplicables.

Ce que la loi demande, c'est que la personne cesse d'être **identifiable**. Les
champs qui l'identifient partent, le reste demeure, et les dossiers restent
cohérents.

```js
const { createAnonymizer } = require('@astratra/privacy');

const anonymizer = createAnonymizer({
  fields: {
    fullName: 'redact',
    email:    (_v, { token }) => `efface-${token}@invalid`,
    phone:    'clear',
  },
  // Ce qu'une réécriture de champ ne peut pas exprimer : invalider les
  // sessions, retirer les abonnements aux notifications, révoquer les jetons.
  onAnonymised: async (compte) => {
    compte.tokenVersion = (compte.tokenVersion || 0) + 1000;
  },
});

await anonymizer.anonymise(compte);
await compte.save();   // la persistance reste ta décision
```

Deux garde-fous que les tests fixent :

**Un champ que la fiche ne porte pas est ignoré, jamais inventé.** Ajouter
`parentPhone` à une fiche de salarié serait créer une donnée personnelle
nouvelle au moment même de l'effacement.

**C'est irréversible par construction.** Il n'y a pas d'annulation, et il ne
doit pas y en avoir : une anonymisation réversible n'a rien anonymisé.

## L'effacement passe par un humain

Un bouton de suppression irréversible en un clic est un cadeau pour qui
emprunte une session trente secondes, et pour l'utilisateur qui passe une
mauvaise journée.

`createMemoryErasureStore()` sert aux tests et au développement : un journal
d'effacement qui disparaît au redémarrage n'est pas une piste d'audit.

```js
const { createErasureWorkflow } = require('@astratra/privacy');

const workflow = createErasureWorkflow({
  store,
  erase: async (demande) => {
    const compte = await Comptes.findById(demande.subject);
    await anonymizer.anonymise(compte);
    await compte.save();
  },
});

await workflow.request({ subject: userId, reason: 'je quitte le service' });
await workflow.pending();                                     // ce qui attend
await workflow.approve(id, { reviewedBy: adminId, note: '…' }); // exécute
await workflow.reject(id, { reviewedBy: adminId, note: '…' });
```

Trois règles tenues par le code, pas par la discipline :

**Personne n'approuve sa propre demande.** Le but de la barrière est une
seconde paire d'yeux ; s'approuver soi-même restaure le bouton en un clic.

**Une opération irréversible ne s'exécute pas deux fois.** Une demande déjà
tranchée renvoie 409.

**Un effacement en échec est enregistré comme échoué, jamais comme terminé.**
Consigner une réussite qui n'a pas eu lieu, c'est dire à un régulateur qu'on a
effacé des données qu'on détient toujours.

## La suppression de compte en libre-service

Les magasins d'applications exigent qu'une personne puisse supprimer son compte
elle-même, sans écrire au support. Le faire en un clic irréversible est deux
fois faux : ça punit le geste impulsif, et ça donne à qui emprunte une session
le pouvoir de détruire le compte pour de bon.

Donc la demande **suspend** le compte tout de suite, et l'effacement n'a lieu
qu'à l'échéance (30 jours par défaut, `graceMs`). Se reconnecter ou annuler
pendant le délai rétablit tout.

```js
const { createAccountDeletion, createAnonymizer } = require('@astratra/privacy');
const { createJobLock, createMongoLockStore } = require('@astratra/resilience');

const suppression = createAccountDeletion({
  store,                               // voir createMemoryDeletionStore()
  // L'effacement n'est PAS réimplémenté : il délègue à l'anonymiseur.
  erase: async (id) => {
    const compte = await Comptes.findById(id);
    await anonymizer.anonymise(compte);
    await compte.save();
  },
  // Les règles produit, en codes que le client traduit.
  canRequest: async (id, { dernierAdministrateur }) => (dernierAdministrateur ? 'last_manager' : null),
  suspend: async (id) => Comptes.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } }),
  notify: {
    send: (id, message) => mailer.send(id, message),
    // Les textes viennent de toi, jamais du paquet.
    messages: {
      scheduled: ({ daysLeft }) => t('suppression.programmee', { daysLeft }),
      cancelled: ({ by }) => t('suppression.annulee', { by }),
      reminder:  ({ daysLeft }) => t('suppression.imminente', { daysLeft }),
    },
  },
  lock: createJobLock({ store: createMongoLockStore(db.collection('locks')) }),
});

await suppression.request(userId, contexte);   // { ok, record } | { ok: false, reason }
await suppression.cancel(userId);              // depuis les réglages
await suppression.onSignIn(userId);            // après le second facteur, jamais avant
await suppression.status(userId);
await suppression.sweep();                     // tâche quotidienne
```

Ce que les tests fixent :

**Rien n'est effacé avant l'échéance**, même si l'adaptateur de stockage renvoie
trop de lignes : l'échéance est revérifiée. Une fiche sans date n'est jamais
considérée comme due.

**Chaque transition est conditionnelle** (`update`/`remove` avec les champs
attendus). Une reconnexion qui arrive pendant la passe ne peut pas être
effacée sur la foi d'une lecture périmée ; deux instances n'effacent pas deux
fois ; deux appuis simultanés ne programment qu'une fois.

**`onSignIn` ne lève jamais** : le mécanisme censé faire revenir la personne ne
doit pas l'enfermer dehors. Appelle-le quand la session est vraiment accordée,
second facteur compris — sinon le seul mot de passe ressuscite le compte.

**Chaque annulation prévient le titulaire.** Une reconnexion faite par quelqu'un
d'autre ne ramène pas le compte en silence.

**Si la suspension échoue, la demande est défaite.** Un compte « fermé » dont
les sessions restent ouvertes est pire qu'une demande qui échoue visiblement.

**Un courrier en échec ne défait rien**, et un rappel raté est retenté au
passage suivant. Un effacement en échec reste programmé et repasse.

**La passe est idempotente** et accepte un verrou injecté (`run(name, holdMs,
fn)` qui rend `null` quand une autre instance le tient) : `createJobLock` de
`@astratra/resilience` convient tel quel, sans dépendance.

Ce circuit ne remplace pas `createErasureWorkflow` : la demande d'effacement
revue par un humain reste l'outil quand quelqu'un d'autre a son mot à dire.

## Le droit d'accès

Ce que tout le monde rate n'est pas l'export — c'est le **silence** autour.

Un produit réparti sur trois services exporte ce que le premier détient et ne
dit rien des deux autres. La personne reçoit un fichier qui a l'air complet et
ne l'est pas.

```js
const { createDataExporter } = require('@astratra/privacy');

const exporter = createDataExporter({
  sources: [
    { key: 'compte',   collect: async (id) => Comptes.findById(id) },
    { key: 'commandes', collect: async (id) => Commandes.find({ client: id }) },
    // Nommé, pas caché.
    { key: 'paiements', label: 'Historique des paiements',
      elsewhere: 'détenu par le service de facturation — écrire au support' },
  ],
});

const fichier = await exporter.export(userId);
// { exportedAt, sections, notIncluded, unavailable, complete: false }
```

Une source injoignable ne fait pas couler l'export, mais elle est **nommée**
dans `unavailable`. Un export auquel il manque une section en silence est pire
qu'un export qui dit laquelle n'a pas pu être produite.

## L'anonymisation des journaux

Les journaux partent chez un tiers, sont gardés des mois, et lus par quiconque a
accès au tableau de bord. Une adresse ou un numéro qui atterrit là a quitté ton
système, quoi que dise ta politique de confidentialité.

```js
const { createRedactor } = require('@astratra/privacy');

const redactor = createRedactor({
  extra: [{ pattern: /MAT-\d{4}-\d{4}/g, replacement: '[MATRICULE]' }],
});

logger.error(redactor.redact({ message, user, payload }));
```

Le même outil sert de filtre de données sensibles avant que quoi que ce soit
sorte : journaux, messages envoyés à une IA, exports, tickets de support.

Par défaut, un jeu générique — les mêmes formes dans tous les pays :

- adresses e-mail, téléphones internationaux (et longues suites de chiffres) ;
- cartes bancaires **avec contrôle de Luhn**, IBAN **avec contrôle mod 97** —
  un numéro qui ne passe pas le contrôle n'est pas appelé carte ;
- jetons `Bearer`, JWT, clés de fournisseurs reconnues à leur préfixe
  (`sk_live_`, `AKIA`, `ghp_`, `xoxb-`…), blocs de clé privée, identifiants
  dans une URL (`https://user:pass@…`) ;
- les secrets écrits en clair dans une ligne (`access_token=…`, `secret_key: …`)
  et les champs dont le **nom** suffit, quelle que soit leur graphie
  (`access_token`, `Access-Token`, `accessToken`).

Les identifiants propres à un pays ou une langue (numéro national, format de
téléphone local, matricule) sont **les tiens**, via `extra`, avec au besoin
leur propre `validate(match)`.

```js
const { value, found, clean } = redactor.inspect(messagePourLIA);
// found = { email: 1, card: 1 } — les compteurs, jamais les valeurs
if (found.card) return refuser();
```

Les faux positifs corrigés et fixés par les tests : une date `2026-09-19 10:00`
reste lisible, le dernier groupe d'un UUID aussi, `tokens: 1500` n'est pas un
secret.

Trois choix qui comptent :

**Les motifs ajoutés passent avant ceux par défaut.** Le motif « téléphone » est
volontairement large et mangerait `2026-0001` d'un matricule. Le spécifique
avant le générique, sinon un motif sur mesure ne se déclenche jamais.

**Le nom du champ est conservé, seule la valeur part.** Renommer un champ casse
celui qui lit le journal en le cherchant.

**La structure est parcourue, pas sérialisée.** Transformer l'objet en JSON,
passer des expressions régulières dessus et le reparser est plus rapide à écrire
et discrètement faux : ça réécrit aussi les **clés**, et un remplacement
contenant une accolade corrompt le document qu'il devait nettoyer.

Les structures cycliques et absurdement profondes sont bornées — journaliser est
exactement l'endroit où l'on rencontre les deux.

## Ce que ce package ne fait pas

- Il ne **supprime** rien : il anonymise, via ce que tu branches.
- Il ne sauvegarde pas — la persistance et les transactions restent à toi.
- Il ne décide pas **qui** a le droit d'approuver un effacement.
- Il ne connaît aucune juridiction et ne prétend pas te rendre conforme : il
  fournit les gestes, pas l'avis juridique.

## Tests

```bash
npm test --workspace @astratra/privacy
```
