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

## Le transporteur Sendcloud

```js
const { createSendcloudCarrier, messageFor } = require('@astratra/shipping');

const carrier = createSendcloudCarrier({
  publicKey: () => coffre.lire('SENDCLOUD_PUBLIC_KEY'),
  secretKey: () => coffre.lire('SENDCLOUD_SECRET_KEY'),
  testMode: process.env.NODE_ENV !== 'production'
});

await carrier.status(); // { configured, missing: ['secretKey'], testMode } — jamais une valeur

const methodes = await carrier.shippingMethods({ country: 'FR', weightGrams: 1250 });
// [{ id, name, carrier, servicePointRequired, priceCents }]

const points = await carrier.servicePoints({
  country: 'FR', postalCode: '13002', carriers: ['mondial_relay', 'colissimo'], limit: 10
});
const methodesRelais = await carrier.shippingMethods({ country: 'FR', weightGrams: 1250, servicePointId: points[0].id });

const etiquette = await carrier.createLabel({
  orderNumber: 'R-1042',
  recipient: { name: 'Awa Diallo', line1: '12 rue des Lilas', city: 'Lyon', postalCode: '69003', country: 'FR', email: 'awa@example.com' },
  weightGrams: 1250,
  method: methodes[0]
});
// { parcelId, trackingNumber, trackingUrl, carrier, service, testMode }

const { content } = await carrier.downloadLabel({ parcelId: etiquette.parcelId, format: 'a6' }); // PDF
await carrier.cancelLabel({ parcelId: etiquette.parcelId }); // { status: 'cancelled' | 'requested' }
```

- `servicePoints` : par code postal et/ou ville, ou par coordonnées ; un ou
  plusieurs transporteurs (codes Sendcloud : `mondial_relay`, `colissimo`,
  `chronopost`…), tous par défaut ; rayon (`radiusMeters`, 10 km) et nombre
  (`limit`, 15) en option ; du plus proche au plus loin. Les résultats sont
  gardés 2 minutes (`servicePointsCacheSeconds`, `false` pour couper).
- `priceCents` est le tarif indicatif donné par Sendcloud : tes prix restent les
  tiens.
- Une annulation `requested` veut dire que Sendcloud a transmis la demande au
  transporteur, qui peut encore la refuser ; un 410 est déjà annulé.

### Mode test

`testMode: true` crée chaque étiquette sur la méthode « Unstamped letter »
(lettre non affranchie) de Sendcloud, cherchée **par son nom** dans les méthodes
du pays : son identifiant change d'un compte à l'autre et Sendcloud demande de
ne pas le garder. Rien n'est posté et aucun port n'est facturé (Sendcloud peut
compter des frais de traitement : voir sa documentation). Le point relais
demandé est ignoré en mode test, et `label.testMode` vaut `true`.

### API v2 et v3

L'adaptateur utilise l'API REST v2 de Sendcloud, celle de Boutique Roro en
production. Sendcloud la passe en maintenance et conseille la v3 aux nouveaux
comptes (`ship_with`, code `sendcloud:letter` pour la lettre de test) : un
adaptateur v3 pourra s'ajouter derrière le même contrat.

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

- En-tête `sendcloud-signature` : HMAC-SHA256 du corps brut avec la clé secrète.
- Signature fausse, corps déjà analysé ou illisible : **400**, pour que Sendcloud
  ne renvoie pas indéfiniment. Sans clé secrète, tout est refusé.
- Un autre type d'événement que `parcel_status_changed` : **200**, ignoré.
- Un renvoi du même corps : **200** `duplicate`, sans rien refaire.
- Une erreur dans tes fonctions : **500** et l'événement est libéré, le renvoi
  de Sendcloud sera traité.
- `stage` de l'événement : `picked_up`, `delivered`, `incident` ou `null`
  (`classifySendcloudStatus`). Une tentative de livraison ratée ou un retard
  reste `picked_up` : ce n'est pas un incident définitif.

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
