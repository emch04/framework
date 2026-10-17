# @astratra/shipping

Les étiquettes d'expédition sans les pièges : un contrat de transporteur, un
adaptateur Sendcloud (étiquettes, points relais, suivi), le webhook de suivi
signé et protégé contre les rejeux, et un mode test sans frais.

Né du code de Boutique Roro, pour toutes les boutiques : le paquet ne connaît
ni commandes, ni tables, ni prix. Il parle au transporteur ; la boutique décide.

```bash
npm install @astratra/shipping
```

## Ce qu'il fait, et les pièges qu'il évite

- **Créer deux fois, c'est payer deux fois.** Seules les lectures sont relancées
  après une panne. `createLabel` n'est jamais relancé : une seconde tentative
  achèterait une seconde étiquette.
- **Un refus n'est pas une panne.** Un 4xx du transporteur (adresse invalide,
  poids hors limite) est une réponse : il ne compte pas pour le disjoncteur et
  n'est pas relancé. Seules les coupures et les 5xx le sont.
- **Les clés ne fuient pas.** Elles viennent des options (une valeur, ou une
  fonction relue à chaque appel : rotation sans redémarrage), jamais d'un
  fichier ni de l'environnement, jamais dans une erreur.
- **Le corps brut signé.** La signature du webhook se vérifie sur les octets
  reçus, en temps constant. Monte le webhook **avant** tout analyseur JSON.
- **Un renvoi n'agit qu'une fois.** Le webhook passe par le tuyau de
  `@astratra/payments` : l'événement (empreinte SHA-256 du corps brut) est
  réservé avant d'être traité, libéré en cas d'échec pour que le renvoi passe.
- **« Étiquette créée » n'est pas « colis pris en charge ».** Seul un scan du
  transporteur fait passer un colis à `picked_up`.

## Le transporteur Sendcloud (API v3)

```js
const { createSendcloudCarrier, messageFor } = require('@astratra/shipping');

const carrier = createSendcloudCarrier({
  publicKey: () => coffre.lire('SENDCLOUD_PUBLIC_KEY'),
  secretKey: () => coffre.lire('SENDCLOUD_SECRET_KEY'),
  webhookSecret: () => coffre.lire('SENDCLOUD_WEBHOOK_KEY'), // si l'intégration a une « Webhook Signature Key »
  sender: { addressId: 12345, country: 'FR' },              // adresse d'expédition enregistrée chez Sendcloud
  testMode: process.env.NODE_ENV !== 'production'
});

await carrier.status(); // { configured, missing: ['secretKey', 'sender'], testMode } — jamais une valeur

const options = await carrier.shippingMethods({ country: 'FR', postalCode: '69003', weightGrams: 1250 });
// [{ id: 'colissimo:home/signature', name, carrier, servicePointRequired, priceCents }]

const points = await carrier.servicePoints({
  country: 'FR', postalCode: '13002', carriers: ['mondial_relay', 'colissimo'], limit: 10
});
const optionsRelais = await carrier.shippingMethods({ country: 'FR', weightGrams: 1250, servicePointId: points[0].id });

const envoi = await carrier.createLabel({
  orderNumber: 'R-1042',
  reference: 'commande-R-1042', // unique : la renvoyer rend le premier envoi, sans racheter d'étiquette
  recipient: { name: 'Awa Diallo', line1: '12 rue des Lilas', city: 'Lyon', postalCode: '69003', country: 'FR', email: 'awa@example.com' },
  weightGrams: 1250,
  method: options[0]
});
// { shipmentId, parcelId, trackingNumber, trackingUrl, carrier, service, label, alreadyExisted, testMode }
// envoi.label : le PDF de l'étiquette, revenu avec l'envoi (un seul colis) — pas de seconde demande

const { content } = await carrier.downloadLabel({ parcelId: envoi.parcelId, format: 'a4' }); // A4, A5 ou A6 (par défaut)
// Pas de « commencer à la case N » sur une planche A4 : l'API v3 de Sendcloud ne le propose pas.
await carrier.cancelLabel({ shipmentId: envoi.shipmentId }); // { status: 'cancelled' | 'requested' }
```

- **L'expéditeur** (`sender`) : l'identifiant d'une adresse enregistrée chez
  Sendcloud avec son pays, ou l'adresse complète (`name`, `line1`, `city`,
  `postalCode`, `country`…). Sans lui, `status()` signale `sender` manquant.
- **Réglages relus à chaque appel** (1.1.0) : `sender` et `testMode` acceptent
  une valeur ou une fonction (éventuellement asynchrone), comme les clés. La
  boutique change son adresse d'expédition ou passe en mode test depuis son
  administration, sans recréer le transporteur :

  ```js
  const carrier = createSendcloudCarrier({
    publicKey, secretKey,
    sender: async () => (await lireReglages()).adresseExpedition, // { addressId, country } ou l'adresse complète
    testMode: async () => (await lireReglages()).modeTest
  });
  ```

  `carrier.testMode` vaut le booléen donné, ou `null` quand c'est une fonction :
  lis alors `(await carrier.status()).testMode`.
- **Les options d'expédition** sont des codes stables (`colissimo:home/signature`,
  `mondial_relay:point`…), jamais des numéros qui changent. `priceCents` est le
  devis de Sendcloud : tes prix restent les tiens.
- **La référence** (`reference`, unique par compte) protège contre le double
  achat : la même référence annoncée deux fois rend le premier envoi
  (`alreadyExisted: true`).
- **Un refus du transporteur** (code postal invalide…) revient de Sendcloud avec
  un statut 201 et une erreur : le paquet en fait une erreur `rejected`.
- **L'annulation** porte sur l'envoi (`shipmentId`). `requested` : Sendcloud
  surveille l'envoi et l'annule s'il ne bouge pas. Refusée si le colis est livré
  ou annoncé depuis plus de 42 jours ; « déjà en cours d'annulation » compte
  comme annulé.
- `servicePoints` : par code postal et/ou ville, ou par coordonnées ; les
  transporteurs choisis (codes Sendcloud), sinon ceux activés sur ton
  intégration ; rayon (`radiusMeters`, 10 km, de 100 m à 50 km) et nombre
  (`limit`, 15) ; du plus proche au plus loin ; gardés 2 minutes
  (`servicePointsCacheSeconds`, `false` pour couper).

### Mode test

`testMode: true` crée chaque étiquette avec l'option `sendcloud:letter` (lettre
non affranchie) : rien n'est posté et aucun port n'est facturé (Sendcloud peut
compter des frais de traitement : voir sa documentation). L'option et le point
relais demandés sont ignorés, et `testMode` vaut `true` dans la réponse.

## Les erreurs

Toute erreur est une `ShippingError` avec un **code stable**, un `status` HTTP à
répondre, et le `providerStatus` du transporteur — jamais son corps ni une clé :

| Code | Statut | Quand |
|---|---|---|
| `not_configured` | 503 | une clé manque |
| `credentials_refused` | 502 | 401 ou 403 du transporteur |
| `unavailable` | 503 | coupure, 5xx, disjoncteur ouvert |
| `rejected` | 422 | étiquette refusée (adresse, poids, méthode) |
| `no_method` | 422 | aucune méthode pour ce pays et ce poids |
| `not_found` | 404 | étiquette introuvable |
| `cancel_refused` | 409 | colis sans doute déjà pris en charge |
| `service_points_unavailable` | 503 | recherche de points relais refusée |
| `invalid_input` | 422 | informations incomplètes ou invalides |
| `unexpected_response` | 502 | réponse illisible |

`messageFor(codeOuErreur, 'fr' | 'en')` donne la phrase à montrer (catalogue de
`@astratra/i18n-server`) ; une langue inconnue donne le français.

## Le webhook de suivi

```js
const express = require('express');
const { Pool } = require('pg');
const { createPostgresEventLog, postgresEventLogSchema } = require('@astratra/payments');
const { createCarrierWebhook } = require('@astratra/shipping');

const pool = new Pool();
await pool.query(postgresEventLogSchema({ table: 'sendcloud_events' }));

const webhook = createCarrierWebhook({
  carrier,
  eventLog: createPostgresEventLog(pool, { table: 'sendcloud_events' }),
  onEvent: async (colis) => { /* chaque statut : noter colis.message, la date du dernier scan… */ },
  onPickedUp: async (colis, { sideEffect }) => {
    await marquerPrisEnCharge(colis.parcelId);
    await sideEffect('e-mail', () => envoyerEmailExpedition(colis)); // ne fait jamais échouer le webhook
  },
  onDelivered: async (colis) => marquerLivre(colis.parcelId),
  onIncident: async (colis) => signalerIncident(colis.parcelId, colis.message)
});

// AVANT express.json : la signature porte sur les octets reçus.
app.post('/api/transporteurs/sendcloud/webhook', express.raw({ type: 'application/json', limit: '1mb' }), webhook.middleware);
```

- En-tête `sendcloud-signature` : HMAC-SHA256 du corps brut, en hexadécimal.
- Signature fausse, corps déjà analysé ou illisible : **400**, pour que Sendcloud
  ne renvoie pas indéfiniment. Sans clé secrète, tout est refusé.
- Un autre type d'événement que `parcel_status_changed` : **200**, ignoré.
- Un renvoi du même corps : **200** `duplicate`, sans rien refaire.
- Une erreur dans tes fonctions : **500** et l'événement est libéré, le renvoi
  de Sendcloud sera traité.
- `stage` de l'événement : `picked_up`, `delivered`, `incident` ou `null`
  (`classifySendcloudStatus`). Une tentative de livraison ratée ou un retard
  reste `picked_up` : ce n'est pas un incident définitif.
- Les notifications peuvent arriver dans le désordre : `timestamp` dit quand le
  statut a changé, **toujours en millisecondes** (1.1.0 : secondes, millisecondes
  ou date ISO sont ramenées en millisecondes), pour ne pas écraser un statut
  récent par un ancien :

  ```js
  onEvent: async (colis) => {
    await pool.query(
      `UPDATE colis SET statut = $2, statut_le = to_timestamp($3 / 1000.0)
        WHERE id = $1 AND (statut_le IS NULL OR statut_le < to_timestamp($3 / 1000.0))`,
      [colis.parcelId, colis.message, colis.timestamp]
    );
  }
  ```
- **Purge de la trace des notifications** (1.1.0) : avec un journal qui sait
  purger (`createPostgresEventLog` de `@astratra/payments`), les événements
  traités de plus de 90 jours sont effacés, au plus une fois par jour, après la
  réponse à Sendcloud (jamais sur son chemin ; un échec est seulement journalisé).
  Réglable : `pruneOlderThanMs` (`false` pour le faire toi-même) et
  `pruneEveryMs`. `webhook.settled()` attend une purge en cours (arrêt propre).
- La signature utilise la « Webhook Signature Key » de l'intégration
  (`webhookSecret`) quand elle existe, sinon la clé secrète.

## Écrire un autre transporteur

Étends `Carrier` et implémente : `name`, `status()`, `shippingMethods()`,
`createLabel()`, `downloadLabel()`, `cancelLabel()`, `servicePoints()`,
`verifySignature()`, `readEvent()`. `createCarrierWebhook` fonctionne avec
n'importe quel transporteur (`signatureHeader` en option).

## Ce que ce paquet ne fait pas

- Pas de prix de livraison, de zones ni de pays livrés : c'est la boutique.
- Pas de commandes, pas de tables (sauf le journal des événements, fourni par
  `@astratra/payments`), pas d'e-mails.
- Pas de limite de débit sur la recherche publique de points relais : mets-la
  devant ta route.

## Tests

```bash
npm test --workspace @astratra/shipping
```

Aucun appel réseau : un faux Sendcloud répond aux requêtes et les enregistre
(relances des lectures seulement, disjoncteur, clés jamais dans les erreurs,
mode test, points relais, signature, rejeux concurrents, échec puis renvoi).
