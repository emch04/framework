# @astratra/notify

Les messages sortants, faits une fois : **e-mail, SMS, notifications poussées**.

Le transport est toujours injecté — SMTP, une API HTTP, Twilio, Infobip,
web-push, Expo. Ce package apporte l'anneau autour, et c'est le même anneau
pour les trois canaux :

- **rien ne lève jamais** — un message est la conséquence d'une action, pas
  l'action ;
- **l'absence de configuration est visible**, jamais silencieuse ;
- **ce qui vient de l'utilisateur ne devient jamais une instruction**.

Aucune dépendance à l'exécution.

---

# E-mail

## Un envoi raté ne fait jamais échouer l'appelant

Un e-mail de confirmation est la **conséquence** d'une action. Quand la
commande est passée et l'argent encaissé, une coupure SMTP ne doit pas se
transformer en erreur 500 qui annonce au client que sa commande a échoué.

Donc rien ne lève. Chaque appel renvoie un résultat que tu peux consulter,
journaliser, ou ignorer.

```js
const { createMailer } = require('@astratra/notify');

const mailer = createMailer({
  channels: {
    transactional: {
      from: 'no-reply@acme.cd',
      fromName: 'Acme',
      send: (message) => transporter.sendMail(message),   // nodemailer, Brevo, Resend…
    },
    alerts: {
      from: 'alertes@acme.cd',
      send: (message) => alertTransporter.sendMail(message),
    },
  },
});

const { sent, reason } = await mailer.send({
  to: 'jean@ecole.cd',
  subject: 'Votre commande est confirmée',
  text, html,
});
```

Plusieurs canaux, parce qu'un reçu et une alerte de sécurité n'ont pas à
voyager sur la même réputation d'expéditeur ni à partager les mêmes
identifiants.

Un canal sans identifiants ne fait pas tomber l'application : il journalise et
laisse passer. Un produit en développement ne doit pas planter à chaque
inscription faute de configuration SMTP.

## L'injection d'en-têtes

Les en-têtes sont séparés par des retours à la ligne. Un saut de ligne dans un
sujet ne reste donc pas dans le sujet : il le **termine** et en commence un
nouveau.

```
subject = "Commande confirmée\r\nBcc: tout@le-monde.cd"
```

Ce qui suit devient un en-tête à part entière. Un formulaire de contact devient
un relais de spam, ou une copie silencieuse de chaque message. C'est une faille
ancienne, bien connue, et livrée tous les jours — parce que la chaîne a l'air
parfaitement ordinaire dans un débogueur.

Tout ce qui atterrit dans un en-tête passe par le nettoyage : sujet, nom
d'expéditeur, destinataires, `Reply-To`.

**Les mots sont conservés, pas supprimés.** Un sujet qui perd la moitié de ses
mots en silence est un rapport de bug que tu ne comprendras jamais.

**Une adresse invalide est refusée, pas réparée.** Un `Reply-To` malformé casse
silencieusement toutes les réponses, et personne ne le signale puisque le
message, lui, est bien arrivé.

**Une seule mauvaise adresse dans une liste ne fait pas perdre les autres.** Les
fournisseurs rejettent le message entier pour une adresse mal formée : une
faute de frappe coûterait tous les autres destinataires.

## Le gabarit HTML

L'e-mail n'est pas le web. Outlook met en page le HTML avec Word, Gmail retire
les blocs `<style>`, et flexbox, grid, les variables CSS et les feuilles
externes sont tout simplement absents. Ce qui marche partout est ce qui marchait
en 2005 : des tableaux imbriqués et des styles en ligne.

```js
const { renderEmail, renderText } = require('@astratra/notify');

const blocks = [
  { type: 'heading',   text: 'Code de modification' },
  { type: 'paragraph', text: 'Votre code :' },
  { type: 'code',      value: '482915' },
  { type: 'button',    label: 'Ouvrir', url: 'https://app.acme.cd' },
  { type: 'note',      text: 'Valable dix minutes.' },
];

await mailer.send({
  to, subject: 'Votre code',
  html: renderEmail({ blocks, preheader: 'Votre code de sécurité', theme: { accent: '#2563eb' } }),
  text: renderText({ blocks }),
});
```

Ce n'est pas un système de design : c'est le plus petit squelette qui arrive
identique dans Gmail, Outlook et Apple Mail, avec tes couleurs dessus.

**Le bouton est un tableau.** Un `<a>` stylé s'effondre en lien nu dans Outlook,
parce que le moteur de Word ignore le `padding` sur les éléments en ligne.

**Le pré-en-tête** est la ligne affichée à côté du sujet dans la boîte de
réception. Sans lui, les clients attrapent les premiers mots du corps — souvent
un texte alternatif égaré.

**La version texte n'est pas une politesse.** Un message sans partie texte est
moins bien noté par les filtres anti-spam, et certains lecteurs ne voient que
celle-là. La générer depuis les mêmes blocs garde les deux en phase.

**Tout est échappé.** Ça mord bien avant qu'on essaie de t'attaquer : un client
nommé « Dupont & Fils \<SARL\> » casse la mise en page de tous les messages où
il apparaît. Le bloc `html` est la porte de sortie, nommée explicitement pour
qu'elle ne s'ouvre jamais par accident.

## Tester sans serveur mail

```js
const { createCaptureChannel } = require('@astratra/notify');

const capture = createCaptureChannel({ from: 'no-reply@acme.cd' });
const mailer = createMailer({ channels: { transactional: capture } });

await service.confirmerCommande(id);

expect(capture.last().subject).toBe('Votre commande est confirmée');
```

Utile aussi en développement, où un envoi réel atteindrait une vraie personne.

---

# SMS

```js
const { createSmsSender } = require('@astratra/notify');

const sms = createSmsSender({
  transport: ({ to, text }) => twilioClient.messages.create({ to, from, body: text }),
});

const { sent } = await sms.send('+243 810 000 000', `Votre code : ${code}`);
```

**Sans transport configuré, l'envoi est une simulation BRUYANTE.** Le message
part dans le journal, étiqueté `SIMULATION`, et le résultat le dit
(`simulated: true`). Une simulation qui a l'air réelle est pire qu'un échec :
quelqu'un attend un code qui n'a jamais quitté le journal.

Deux protections de plus : le numéro est nettoyé (espaces, points, tirets — ce
qui casse les fournisseurs) sans prétendre le valider, et **le texte est
plafonné** — un texte non borné concaténé dans un SMS est la façon dont un bug
devient une facture.

---

# Notifications poussées

## La leçon qui compte : les abonnements morts

Un abonnement push meurt en silence : application désinstallée, permission
révoquée, profil effacé. Le fournisseur répond 404 ou 410, et à partir de là
chaque envoi vers cet abonnement échoue, pour toujours.

Laissée seule, une liste d'abonnés n'accumule que des cadavres : les envois
ralentissent, les journaux d'erreurs se remplissent d'un bruit qui enterre les
vrais échecs, et certains fournisseurs étranglent les expéditeurs dont le taux
d'échec grimpe.

Un abonnement mort n'est donc pas une erreur à journaliser — c'est un **fait à
traiter** :

```js
const { createPushSender } = require('@astratra/notify');

const push = createPushSender({
  transport: (subscription, payload) =>
    webpush.sendNotification(subscription, JSON.stringify(payload)),
  // LE point du module : l'abonnement mort t'est rendu pour suppression.
  onGone: (subscription) => Subscriptions.deleteOne({ endpoint: subscription.endpoint }),
  concurrency: 10, // défaut : 10 envois simultanés au maximum
  timeoutMs: 30_000, // défaut : un fournisseur a 30 secondes pour répondre
});

const { delivered, gone, failed } = await push.broadcast(subscriptions, payload);
```

Trois issues distinctes, jamais confondues : `delivered`, `gone` (mort, élagué),
`failed` (panne passagère, avec sa raison). Un abonnement mort ou en panne
n'arrête jamais les autres, et un élagage qui échoue ne transforme pas un `gone`
en `failed`.

`broadcast` utilise un nombre borné de workers : un fournisseur lent ne retient
plus tous les abonnements placés derrière lui, sans pour autant déclencher une
rafale non bornée. Un dépassement de `timeoutMs` compte comme `failed` et les
autres envois continuent. La forme du rapport reste exactement
`{ delivered, gone, failed, errors }` ; même si les envois finissent dans le
désordre, `errors` suit toujours l'ordre des abonnements d'entrée (et conserve
sa limite historique de dix raisons).

Le statut du fournisseur est cherché où qu'il l'ait mis — `statusCode`,
`status`, `response.status` — parce que web-push et les clients HTTP ne sont pas
d'accord entre eux.

---

# La boîte de notifications, côté serveur

## Lire par pages, ranger, et ne jamais toucher au compte d'un autre

Trois défauts, tous du même produit :

- La liste rendait « les cinquante dernières », point. Au-delà, une
  notification existait en base sans que personne ne puisse jamais la revoir.
- La suppression prenait un identifiant. Un identifiant se devine, ou fuit —
  dans une URL, un journal, une capture. La **seule** barrière entre
  « supprimer la mienne » et « supprimer celle de n'importe qui » est le
  propriétaire **dans la requête elle-même**, pas une vérification faite après
  et oubliée sur la route suivante.
- « Absente » et « à quelqu'un d'autre » doivent recevoir **la même réponse**.
  Les distinguer dit à un inconnu quels identifiants existent.

```js
const {
  createNotificationInbox, createInboxHandlers, mountInbox,
} = require('@astratra/notify');

const inbox = createNotificationInbox({
  store: myInboxStore,                              // injecté, voir plus bas
  isValidId: (id) => mongoose.isValidObjectId(id),  // 404 au lieu d'une erreur de conversion (500)
  // pageSize: 50, maxPageSize: 100
});

const router = express.Router();
router.use(auth);
mountInbox(router, createInboxHandlers(inbox, {
  owner: (req) => req.user.id,   // la SESSION, jamais le corps ni la requête
}));
app.use('/api/notifications', router);
```

| Route | Réponse |
|---|---|
| `GET /?page=2&limit=20` | `{ notifications, unreadCount, pagination: { total, page, limit, totalPages } }` |
| `GET /:id` | `{ notification }` ou 404 |
| `DELETE /:id` | `{ unreadCount }` ou 404 — absente et étrangère : même 404 |
| `DELETE /read` | `{ deleted, unreadCount }` — les **lues** seulement |
| `PATCH /:id/read`, `PATCH /read-all` | `{ unreadCount }` |

- **Sans paramètre, rien ne change** : première page de cinquante, comme les
  appelants qui n'ont jamais paginé l'attendent. Une valeur absurde (`-4`,
  `abc`) retombe sur le défaut, une trop grande est plafonnée.
- **Le nombre de non-lues revient avec chaque suppression** : la pastille se
  recale sans attendre le prochain relevé.
- **Ranger n'efface pas ce qu'on n'a pas vu** : `DELETE /read` garde les
  non-lues.
- **`mountInbox` enregistre les chemins fixes AVANT `/:id`.** Sinon
  `DELETE /read` est lu comme « supprimer la notification d'identifiant
  "read" », répond 404, et le bouton de rangement ne fait rien sans rien dire.
- Tes enveloppes de réponse passent par `respond: (res, status, body) => …`.

### Le stockage est injecté

Chaque méthode reçoit `ownerId` et **doit l'appliquer dans la requête** :

```js
const myInboxStore = {
  list:  ({ ownerId, offset, limit }) => Notification.find({ userId: ownerId })
           .sort({ createdAt: -1, _id: -1 })   // _id départage deux avis du même instant
           .skip(offset).limit(limit).lean(),
  count: ({ ownerId, read }) => Notification.countDocuments({ userId: ownerId, ...(read === undefined ? {} : { read }) }),
  get:   ({ ownerId, id }) => Notification.findOne({ _id: id, userId: ownerId }).lean(),
  remove: async ({ ownerId, id }) => (await Notification.deleteOne({ _id: id, userId: ownerId })).deletedCount,
  removeRead: async ({ ownerId }) => (await Notification.deleteMany({ userId: ownerId, read: true })).deletedCount,
  markRead: async ({ ownerId, id }) => (await Notification.updateOne({ _id: id, userId: ownerId }, { read: true })).matchedCount,
  markAllRead: async ({ ownerId }) => (await Notification.updateMany({ userId: ownerId, read: false }, { read: true })).modifiedCount,
};
```

Sans départage par identifiant, une base rend les égalités dans l'ordre qui
lui plaît, et peut changer d'avis d'une requête à l'autre : une notification
apparaît alors sur deux pages, ou sur aucune.

`createMemoryInboxStore()` est l'adaptateur de référence, pour les tests : il
**applique** le filtre propriétaire comme une base le ferait, et refuse une
requête sans propriétaire. Une boîte qui oublierait de le passer atteindrait
ici l'autre compte exactement comme en production — c'est ce qui rend les
tests honnêtes.

## Des notifications traduites, et un texte neutre pour l'écran verrouillé

Une notification produite par le serveur (une note, une facture, un résultat)
est une clé et des paramètres ; le titre et le message sont rendus pour chaque
destinataire, dans sa langue. **Les textes sont à toi** : ce package n'en
contient aucun.

La leçon qui justifie un module plutôt qu'un dictionnaire : un push s'affiche
sur un **écran verrouillé**, sous les yeux de quiconque tient ou regarde le
téléphone. Une décision de fin d'année sur un enfant y est apparue en toutes
lettres — sous un titre pourtant rendu neutre, puisque le corps était le
message lui-même. Une entrée peut donc déclarer `pushBody` : une ligne neutre
qui remplace le message **dans le push seulement**. La boîte, l'écran et
l'e-mail — lu dans une boîte personnelle, une fois déverrouillé — gardent le
message complet.

```js
const { createNotificationCatalog } = require('@astratra/notify');

const catalog = createNotificationCatalog({
  languages: ['fr', 'en'],
  entries: [grades, billing],   // un objet par domaine ; une clé en double lève au démarrage
});

// grades.js
module.exports = {
  year_result: {
    fr: (p) => ({ title: 'Résultat de fin d\'année disponible', message: `${p.student} …`, pushBody: 'Ouvrez l\'application pour le consulter.' }),
    en: (p) => ({ title: 'End-of-year result available',       message: `${p.student} …`, pushBody: 'Open the app to view it.' }),
  },
};

const n = catalog.render('year_result', recipientLanguage, { student: 'Ada' });
await inboxStore.create({ ownerId, title: n.title, message: n.message }); // complet
await push.broadcast(devices, n.push);                                    // { title, body } neutre
```

Une langue non écrite pour une clé retombe sur la langue par défaut
(`n.language` dit laquelle a été rendue) ; chaque entrée doit donc exister
dans la langue par défaut. Une clé inconnue lève : c'est une faute de frappe
dans le code.

### L'audit

```js
test('le catalogue des notifications', () => {
  const report = catalog.audit({ params: SAMPLE_PARAMS });
  expect(report.pushBodyGaps).toEqual([]);
  expect(report.placeholders).toEqual([]);
  expect(report.errors).toEqual([]);
});
```

- `pushBodyGaps` : un corps neutre déclaré dans certaines langues et oublié
  dans d'autres. La fuite n'existe que dans la langue oubliée — personne ne la
  voit en relisant le catalogue dans la sienne.
- `placeholders` : `undefined`, `null`, `NaN` ou `[object Object]` dans un
  texte rendu — un paramètre attendu et jamais reçu.
- `missing` : les langues non écrites, servies dans la langue par défaut.

---

## Ce que ce package ne fait pas

- Il n'envoie **rien** lui-même : les transports sont injectés. Aucun SDK — ni
  nodemailer, ni Twilio, ni web-push — n'est importé.
- Il ne stocke pas les abonnements : il te rend les morts, tu les supprimes.
  Il ne tient pas non plus de registre d'appareils par compte : tu choisis la
  liste, `broadcast` l'envoie.
- La boîte de notifications ne crée pas les notifications et ne les pousse
  pas : elle lit, range et supprime ce que ton stockage contient.
- Il ne fait ni file d'attente ni relance — voir `@astratra/resilience`.
- Il ne gère pas le temps réel (websockets).
- Il n'a pas d'avis sur ton identité visuelle, seulement sur ce qui survit aux
  clients mail.

## Tests

```bash
npm test --workspace @astratra/notify
```
