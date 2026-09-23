# @astratra/wallet

Des cartes de fidélité dans **Apple Wallet** et **Google Wallet**, qui se
mettent à jour toutes seules. Le client n'installe rien et ne crée aucun
compte : il touche « Ajouter », la carte vit dans son téléphone, et ton serveur
la tient à jour.

Ce package ne connaît ni tes clients, ni ta base, ni ta règle de fidélité (voir
`@astratra/loyalty` pour celle-ci). Il signe, publie et rafraîchit des cartes ;
le contenu vient de toi.

## Ce qu'il règle

- **La signature Apple** : `.pkpass` signé avec ton certificat Pass Type ID.
  L'identifiant de carte et l'équipe sont **lus dans le certificat**, et le
  certificat intermédiaire WWDR G4 d'Apple est fourni : deux champs à saisir au
  lieu de cinq.
- **Les mises à jour Apple** : le service web du protocole Apple (inscription
  des appareils, cartes changées, dernière version, désinscription) et la
  notification push vide qui déclenche le rafraîchissement. Les jetons morts
  (400, 410) sont oubliés.
- **Google** : classe et carte créées au premier envoi puis mises à jour, lien
  « Ajouter à Google Wallet » signé (JWT RS256).
- **Le retrait** : carte Apple annulée (grisée), carte Google inactive,
  appareils oubliés.
- **La saisie des clés** : contrôles avant enregistrement (clé qui correspond au
  certificat, certificat non expiré, vrai compte de service Google), et un
  transport hexadécimal pour qu'un PEM traverse un pare-feu applicatif qui
  bloque `--` sans l'affaiblir.

## Apple Wallet

```js
const { createApplePasses, createAppleWebServiceRouter, createMongooseRegistrationStore,
  notifyApplePass } = require('@astratra/wallet');

const passes = createApplePasses({
  certificate, privateKey,                                  // PEM, depuis tes clés chiffrées
  webServiceURL: 'https://api.exemple.com/api/wallet/apple',
  organizationName: 'Mon salon',
  description: 'Carte de fidélité',
  images: { 'icon.png': icon, 'icon@2x.png': icon2x, 'logo.png': logo, 'logo@2x.png': logo2x },
  colors: { backgroundColor: 'rgb(11, 16, 32)', foregroundColor: 'rgb(242, 245, 251)', labelColor: 'rgb(111, 180, 255)' }
});

const pkpass = passes.build({
  serialNumber: 'C-000142',
  authenticationToken: client.carteToken,                  // 16 caractères minimum
  headerFields: [{ key: 'numero', label: 'CARTE N°', value: 'C-000142' }],
  secondaryFields: [{ key: 'client', label: 'CLIENT', value: 'Karim' }],
  barcode: { message: 'Carte C-000142 · 5 / 7', altText: 'C-000142' },
  images: { 'strip.png': bandeDuMoment }                   // propre à cette carte
});
```

Le service web, monté sous le `webServiceURL` :

```js
const registrations = createMongooseRegistrationStore(mongoose.connection);

app.use('/api/wallet/apple', createAppleWebServiceRouter({
  resolveConfig: async () => (appleConfigure ? { passTypeIdentifier: passes.passTypeIdentifier } : null),
  findPass: async (serial) => clients.parCarte(serial),     // { authenticationToken, updatedAt }
  buildPass: async (serial) => passes.build(await contenuDeLaCarte(serial)),
  registrations
}));
```

Après chaque changement (visite validée, récompense accordée…), mets à jour
`updatedAt` puis préviens les appareils :

```js
await notifyApplePass({ registrations, passTypeIdentifier, serialNumber, certificate, privateKey });
```

## Google Wallet

```js
const { createGoogleWallet } = require('@astratra/wallet');

const google = createGoogleWallet({ issuerId, credentials });   // credentials : JSON du compte de service
const classId = google.classId('fidelite');

await google.ensureClass({ id: classId, issuerName: 'Mon salon', programName: 'Fidélité',
  programLogo: { sourceUri: { uri: 'https://…/logo.png' } }, hexBackgroundColor: '#0b1020' });

await google.upsertObject({
  id: google.objectId('C-000142'), classId, state: 'ACTIVE',
  accountId: 'C-000142', accountName: 'Karim',
  loyaltyPoints: { label: 'Prestations', balance: { int: 5 } },
  heroImage: { sourceUri: { uri: 'https://…/bande-5.png' } },
  barcode: { type: 'QR_CODE', value: 'Carte C-000142 · 5 / 7' }
});

const lien = google.saveLink([{ id: google.objectId('C-000142'), classId }]);
```

Une image référencée par Google doit être **publique** : Google la télécharge
depuis ses serveurs. Change son URL quand son contenu change, c'est ce qui force
Google à la rafraîchir.

## Retirer une carte

Une carte ajoutée à un téléphone n'en sort que par la main de son porteur :
ni Apple ni Google ne laissent l'émetteur l'effacer. Ce qu'on peut faire
quand une carte est supprimée chez toi :

```js
// Apple : la carte se grise et se déclare inutilisable.
passes.build({ ...contenu, voided: true });
// puis préviens les appareils, qui viennent chercher cette version :
await notifyApplePass({ registrations, passTypeIdentifier, serialNumber, certificate, privateKey });

// Google : la carte passe inactive, rangée avec les cartes passées.
await google.deactivateObject(google.objectId('C-000142'));   // false si personne ne l'avait ajoutée

// Plus rien à envoyer à ses appareils :
await registrations.forgetPass(passTypeIdentifier, 'C-000142');
```

**L'ordre compte pour Apple.** Pour récupérer la version annulée, l'appareil
demande d'abord quelles cartes ont changé (il faut encore son inscription),
puis la carte elle-même (il faut encore `findPass` et `buildPass`). Garde donc
de quoi servir la carte annulée — son numéro, son jeton, `voided: true` — et
n'appelle `forgetPass` qu'une fois qu'il n'y a plus rien à lui dire. L'appareil
se désinscrit tout seul quand le porteur supprime la carte.

## Saisir les clés depuis l'interface

```js
const { checkAppleCredentials, checkGoogleCredentials, fromHexField } = require('@astratra/wallet');

const certificate = fromHexField(req.body.certificate);   // l'interface envoie toHexField(pem)
const privateKey = fromHexField(req.body.privateKey);
const verdict = checkAppleCredentials({ certificate, privateKey });
if (!verdict.ok) return res.status(400).json({ message: verdict.reason });
```

À combiner avec `@astratra/credentials` pour stocker le certificat et la clé
chiffrés, et les relire à chaque usage : une clé changée prend effet sans
redémarrage.

## À savoir

- **Google démarre en mode démo** : seuls le propriétaire de la console et les
  comptes testeurs voient les cartes. La publication demande un profil de
  paiement Entreprise et une validation de Google (quelques jours).
- **Apple n'a pas de validation** : un certificat valide suffit.
- **Le certificat Pass Type ID expire au bout d'un an et un mois** : au-delà,
  les cartes déjà ajoutées ne se mettent plus à jour. `readPassCertificate`
  donne la date, affiche-la.
- **Badges** : dans un e-mail ou une page, utilise les badges officiels
  (« Ajouter à l'app Cartes Apple », « Ajouter au Google Wallet »), téléchargés
  depuis les kits de marque d'Apple et de Google.
