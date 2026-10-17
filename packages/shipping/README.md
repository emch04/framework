# @astratra/shipping

Shipping labels without the traps: a carrier contract, a Sendcloud adapter
(labels, service points, tracking), the signed tracking webhook with replay
protection, and a free test mode.

Extracted from Boutique Roro, for every shop: the package knows no orders, no
tables and no prices. It talks to the carrier; the shop decides.

[Version française](README.fr.md)

```bash
npm install @astratra/shipping
```

## What it does, and the traps it avoids

- **Creating twice is paying twice.** Only reads are retried after an outage.
  `createLabel` is never retried: a second attempt would buy a second label.
- **A refusal is not an outage.** A carrier 4xx (invalid address, weight out of
  range) is an answer: it does not count against the circuit breaker and is not
  retried. Only network failures and 5xx are.
- **Keys do not leak.** They come from options (a value, or a function read on
  every call: rotation without restart), never from a file or the environment,
  never inside an error.
- **The signed raw body.** The webhook signature is checked on the bytes
  received, in constant time. Mount the webhook **before** any JSON parser.
- **A resend acts once.** The webhook runs on `@astratra/payments`' pipeline:
  the event (SHA-256 of the raw body) is reserved before it is handled, and
  released on failure so the resend goes through.
- **"Label created" is not "parcel picked up".** Only a carrier scan moves a
  parcel to `picked_up`.

## The Sendcloud carrier

```js
const { createSendcloudCarrier, messageFor } = require('@astratra/shipping');

const carrier = createSendcloudCarrier({
  publicKey: () => vault.read('SENDCLOUD_PUBLIC_KEY'),
  secretKey: () => vault.read('SENDCLOUD_SECRET_KEY'),
  testMode: process.env.NODE_ENV !== 'production'
});

await carrier.status(); // { configured, missing: ['secretKey'], testMode } — never a value

const methods = await carrier.shippingMethods({ country: 'FR', weightGrams: 1250 });
const points = await carrier.servicePoints({ country: 'FR', postalCode: '13002', carriers: ['mondial_relay', 'colissimo'], limit: 10 });
const label = await carrier.createLabel({
  orderNumber: 'R-1042',
  recipient: { name: 'Awa Diallo', line1: '12 rue des Lilas', city: 'Lyon', postalCode: '69003', country: 'FR' },
  weightGrams: 1250,
  method: methods[0]
});
const { content } = await carrier.downloadLabel({ parcelId: label.parcelId, format: 'a6' }); // PDF
await carrier.cancelLabel({ parcelId: label.parcelId }); // { status: 'cancelled' | 'requested' }
```

- `servicePoints`: by postal code and/or city, or by coordinates; one or more
  carriers (Sendcloud codes such as `mondial_relay`, `colissimo`,
  `chronopost`), all by default; `radiusMeters` (10 km) and `limit` (15);
  nearest first; cached 2 minutes (`servicePointsCacheSeconds`, `false` to
  disable).
- `priceCents` is Sendcloud's indicative price: your prices stay yours.
- **Test mode** (`testMode: true`) puts every label on Sendcloud's "Unstamped
  letter", found **by name** (its id differs between accounts and must not be
  stored): nothing is posted and no postage is charged (Sendcloud may charge a
  processing fee). The requested service point is ignored in test mode.
- **API v2 and v3.** The adapter targets Sendcloud's REST API v2, the one Boutique
  Roro runs in production. Sendcloud puts v2 in maintenance and recommends v3 to
  new accounts; a v3 adapter can be added behind the same contract.

## Errors

Every error is a `ShippingError` with a **stable code** (`not_configured`,
`credentials_refused`, `unavailable`, `rejected`, `no_method`, `not_found`,
`cancel_refused`, `service_points_unavailable`, `invalid_input`,
`unexpected_response`), an HTTP `status` to answer with and the carrier's
`providerStatus` — never its body nor a key. `messageFor(codeOrError, 'fr' | 'en')`
gives the sentence to show (an `@astratra/i18n-server` catalog).

## The tracking webhook

```js
const { createPostgresEventLog } = require('@astratra/payments');
const { createCarrierWebhook } = require('@astratra/shipping');

const webhook = createCarrierWebhook({
  carrier,
  eventLog: createPostgresEventLog(pool, { table: 'sendcloud_events' }),
  onEvent: async (parcel) => { /* every status */ },
  onPickedUp: async (parcel, { sideEffect }) => {
    await markPickedUp(parcel.parcelId);
    await sideEffect('email', () => sendShippingEmail(parcel)); // never fails the webhook
  },
  onDelivered: async (parcel) => markDelivered(parcel.parcelId),
  onIncident: async (parcel) => reportIncident(parcel.parcelId, parcel.message)
});

// BEFORE express.json: the signature covers the received bytes.
app.post('/webhooks/sendcloud', express.raw({ type: 'application/json', limit: '1mb' }), webhook.middleware);
```

Wrong signature, parsed or unreadable body: 400 (no endless retries). Another
event type: 200, ignored. The same body again: 200 `duplicate`. An error in your
handlers: 500 and the event is released, so Sendcloud's resend is handled.

## Another carrier

Extend `Carrier` and implement `name`, `status()`, `shippingMethods()`,
`createLabel()`, `downloadLabel()`, `cancelLabel()`, `servicePoints()`,
`verifySignature()` and `readEvent()`. `createCarrierWebhook` works with any
carrier (`signatureHeader` option).

## Not in this package

Delivery prices, zones and countries served, orders, tables (except the event
log from `@astratra/payments`), emails, and rate limiting of a public service
point search: those belong to the shop.

## Tests

```bash
npm test --workspace @astratra/shipping
```

No network: a fake Sendcloud answers and records every request.
