# @astratra/payments

Le tuyau qu'il faut à tout webhook de paiement, et que tout le monde réécrit mal.

Ce package n'importe **aucun SDK de paiement**. Tu lui passes ta fonction de
vérification de signature ; il s'occupe de tout ce qui l'entoure, c'est-à-dire de
tout ce qui casse en silence.

## Le côté écran : quel plan, quelle page, quelle confirmation

Deux passerelles nomment les mêmes choses différemment et répondent
différemment. L'écran ne doit pas savoir laquelle est derrière.

```js
const flow = createCheckoutFlow({
  notPurchasable: ['trial'],
  confirms: {
    stripe: () => true,
    cinetpay: (payload) => payload?.success === true
  }
});

flow.planAction('pro', 'starter');     // 'choose' | 'current' | 'locked'
readCheckoutUrl(payload);              // checkoutUrl ?? paymentUrl ?? url
```

**Un plan peut être accordé plutôt que vendu.** L'essai est donné à la création
du compte ; proposer de l'acheter produit une erreur côté serveur et de
l'incompréhension côté personne.

**Un compte sans rien à facturer doit se l'entendre dire.** Le bouton de
paiement vérifiait « pas d'identifiant » puis sortait : aucune requête, aucun
message, rien. Un bouton qui ne fait rien passe pour une panne, alors que c'est
une situation parfaitement normale.

**« En attente » n'est pas « échoué ».** Quand la boucle de confirmation
abandonne, le paiement est peut-être passé : le webhook tranchera. Dire à
quelqu'un que son paiement a échoué pendant que son argent est en route est la
pire réponse possible.

**Une passerelle non déclarée n'est jamais confirmée** — le silence ne doit
jamais valoir un accès.

## Les quatre pièges

Chacun tue des paiements pendant que le code a l'air correct.

**1. Le corps brut.** La vérification de signature porte sur les octets exacts
qu'a signés le prestataire. Un analyseur JSON les réécrit, la vérification
échoue alors même avec le bon secret — et l'erreur dit « signature invalide »,
ce qui t'envoie chercher le mauvais bug.

**2. La pile de middlewares.** Le CSRF renvoie 403 à un prestataire qui n'a
aucun cookie à envoyer. Un garde d'authentification rejette un appelant qui
n'est pas un utilisateur. Un limiteur étrangle une rafale de relances. Chaque
couche doit exempter le webhook, et en oublier une est invisible jusqu'à ce que
de l'argent disparaisse.

**3. Répondre 404 à ce qui n'est pas pour soi.** Les webhooks sont à l'échelle
du **compte** : un seul point d'entrée reçoit les événements de tous les flux du
compte. Un 404 fait relancer le prestataire pendant des jours et finit par
marquer la destination défaillante — pour des événements qui n'étaient pas les
tiens.

**4. Un effet de bord qui fait échouer le webhook.** L'argent est encaissé, la
commande confirmée ; si l'e-mail de confirmation lève ensuite, renvoyer 500
demande au prestataire de rejouer tout l'événement.

Ce package traite les pièges 1, 3 et 4. Le 2 est `createWebhookExemption`, parce
que ton application est seule à connaître ses propres middlewares.

## Le tuyau

```js
const { createWebhookHandler, createMemoryEventLog } = require('@astratra/payments');

// Développement seulement. En production, un store partagé qui fournit
// claim / release / record (voir « Les rejeux »).
const eventLog = createMemoryEventLog();

const webhook = createWebhookHandler({
  // À toi, parce que c'est propre au prestataire. DOIT lever si la signature
  // ne correspond pas.
  verify: ({ payload, headers, secret }) =>
    stripe.webhooks.constructEvent(payload, headers['stripe-signature'], secret),

  // Une fonction, donc relue à chaque appel : le secret se change depuis une
  // interface sans redémarrage. Se marie avec @astratra/credentials.
  secret: () => vault.get('STRIPE_WEBHOOK_SECRET'),

  eventLog,   // protection contre les rejeux : claim / release / record (voir « Les rejeux »)

  events: {
    'checkout.session.completed': async (event, { sideEffect, unrelated }) => {
      const order = await orders.findBySession(event.data.object.id);

      // Piège 3 : cet événement appartient à un autre flux du même compte.
      if (!order) return unrelated('cette session n\'est pas une commande');

      await orders.confirm(order.id);

      // Piège 4 : l'argent est déjà pris. Un envoi raté ne doit pas
      // provoquer une relance.
      await sideEffect('e-mail de confirmation', () => mail.sendReceipt(order));
    },
  },
});

app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhook.middleware);
```

### Ce que chaque réponse veut dire

Le code HTTP n'est pas décoratif : le prestataire le lit comme une consigne.

| Situation | Réponse | Pourquoi |
|---|---|---|
| traité | 200 | terminé |
| type d'événement inconnu | 200 | acquitté, pas une erreur |
| `unrelated(...)` | 200 | « reçu, pas mon circuit » |
| déjà traité, ou en cours de traitement par une autre livraison | 200 (`duplicate`) | rejeu reconnu, réservé avant le traitement |
| signature invalide | **400** | relancer ne changerait rien |
| le gestionnaire a levé | **500** | réservation libérée : là, une relance peut aider |

Le 400 sur signature invalide est délibéré. Un 500 ferait relancer un message
que le prestataire a mal signé, ou que tu ne sais pas vérifier — indéfiniment.

## L'exemption partagée

Un seul prédicat, utilisé par toutes les couches, ne peut pas diverger.

```js
const { createWebhookExemption } = require('@astratra/payments');

const isWebhook = createWebhookExemption({ prefix: '/api/finance/', suffix: '/webhook' });

app.use((req, res, next) => isWebhook(req) ? next() : express.json()(req, res, next));
app.use(csrf({ skip: isWebhook }));
app.use(subscriptionGuard({ skip: isWebhook }));
```

Le préfixe **et** le suffixe ensemble : un préfixe seul exempterait toute une
section de l'API — une zone de facturation entière sans CSRF ni
authentification.

Dans un cas réel, quatre couches exemptaient chacune un webhook et en oubliaient
un second. Chaque paiement de ce flux mourait avant d'atteindre le code censé
l'enregistrer, et rien ne journalisait d'erreur.

## Les rejeux

Les prestataires renvoient les événements, volontairement : ils ne peuvent pas
distinguer une réponse perdue d'une réponse lente. Sans mémoire, la seconde
livraison reconfirme la commande, renvoie le reçu, recrédite le compte.

Et ils renvoient **en même temps** : une relance peut arriver pendant que la
première livraison tourne encore. « Déjà vu ? » puis « je m'en souviens » laisse
une fenêtre où les deux livraisons répondent non, et la commande est confirmée
deux fois. L'événement est donc **réservé de façon atomique avant le
traitement** :

```
claim(eventId, meta)   -> boolean   vrai : réservé maintenant, à traiter.
                                    faux : déjà traité ou en cours → 200 « duplicate ».
release(eventId)       -> void      le handler a échoué : réservation libérée,
                                    la relance du prestataire pourra passer.
record(eventId, meta)  -> void      traité : la réservation devient définitive.
seen(eventId)          -> boolean   traité (une réservation en cours ne compte pas).
```

En SQL, `claim` tient en une instruction sur une clé unique :

```sql
INSERT INTO webhook_events (id, status, claimed_at) VALUES ($1, 'pending', now())
ON CONFLICT (id) DO UPDATE SET claimed_at = now()
  WHERE webhook_events.status = 'pending'
    AND webhook_events.claimed_at < now() - interval '15 minutes'
RETURNING id;  -- une ligne renvoyée = réservé
```

Une réservation **doit expirer** : un processus qui plante en plein traitement ne
la libère jamais (`createMemoryEventLog({ claimTtlMs })`, 15 min par défaut).

Un ancien journal `{ seen, record }` est encore accepté, mais **il n'est pas
atomique** : deux livraisons simultanées passent toutes les deux. Un
avertissement est journalisé à la création ; ajoute `claim` et `release`.

`createMemoryEventLog()` sert aux tests et au développement. **Il n'est pas sûr
en production multi-instances** : chaque processus a sa propre mémoire, donc un
rejeu qui arrive sur l'autre passe. Utilise un store partagé.

### Le journal PostgreSQL (1.1.0)

`createPostgresEventLog(pool, { table, claimTtlMs })` tient le même contrat dans
une table partagée par toutes les instances : `claim` est l'instruction
`INSERT … ON CONFLICT` ci-dessus, une réservation inachevée expire après
`claimTtlMs` (15 min par défaut), `release` ne libère qu'une réservation en
cours, jamais un événement déjà traité.

```js
const { Pool } = require('pg');
const { createPostgresEventLog, postgresEventLogSchema } = require('@astratra/payments');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(postgresEventLogSchema({ table: 'webhook_events' })); // une fois (migration)
const eventLog = createPostgresEventLog(pool, { table: 'webhook_events' });

// De temps en temps : les événements traités de plus de 90 jours ne reviendront plus.
await eventLog.prune(90 * 24 * 3600_000);
```

Le paquet ne dépend pas de `pg` : `pool` est n'importe quel objet avec
`query(texte, paramètres)`. Le nom de table (éventuellement `schéma.table`) est
vérifié et cité ; les identifiants d'événements passent toujours en paramètres.

Un événement **en échec n'est pas enregistré** : sa réservation est libérée et
la relance doit pouvoir fonctionner. Un événement déclaré `unrelated` non plus.
Un type d'événement sans handler ne prend aucune réservation.

## Ce que ce package ne fait pas

- Il n'importe **aucun SDK** — ni Stripe, ni autre.
- Il ne crée pas de session de paiement et ne rembourse rien : ces appels sont
  propres au prestataire et tiennent en trois lignes chez toi.
- Il ne stocke pas tes commandes.
- Aucune dépendance à l'exécution.

## Tests

```bash
npm test --workspace @astratra/payments
```

Les tests du journal PostgreSQL tournent sur une vraie base quand
`PAYMENTS_TEST_DATABASE_URL` désigne une base dont le nom finit par `_test`
(sinon ils sont sautés) : le même contrat que le journal en mémoire, plus deux
instances sur une même table et la purge.

Un test traverse une vraie pile Express avec CSRF et analyseur JSON, et vérifie
que les octets signés arrivent intacts — puis que sans l'exemption, le CSRF
répond bien 403.
