# @astratra/booking

Prise de rendez-vous : calcul des créneaux libres et réservation **sans
double réservation**. Pour l'accueil d'une entreprise (module Accueil de
Cortex), un salon (Barber Clean), une salle de réunion, un cours collectif.

Aucune dépendance. Les fuseaux horaires passent par `Intl`, inclus dans Node.

## Le problème

« Afficher les créneaux libres » cache plusieurs pièges :

- **les fuseaux et les changements d'heure** : 09:00 à Paris vaut 08:00 UTC
  en hiver et 07:00 UTC en été ; la nuit du changement, une heure n'existe
  pas ou existe deux fois ;
- **les tampons** : le nettoyage après une coupe bloque le fauteuil, sans
  être une prestation ;
- **la concurrence** : deux clients cliquent sur le dernier créneau à la même
  seconde ; un seul doit l'obtenir, même avec quatre processus serveur.

## Ressources et prestations

Une **ressource** est ce qui se réserve : une personne, une salle, un siège.
Ses horaires s'écrivent en heure murale de **son** fuseau.

```js
const barbier = {
  id: 'barbier-1',
  timeZone: 'Africa/Kinshasa',
  country: 'CD',                 // ses jours fériés ferment la ressource
  capacity: 1,                   // places en même temps (cours collectif : 12)
  weekly: {
    monday: [['09:00', '12:00'], ['14:00', '18:00']],
    saturday: [['09:00', '13:00']]
  },
  exceptions: [
    { from: '2026-08-01', to: '2026-08-15', reason: 'congés' },  // période fermée, bornes incluses
    { date: '2026-12-24', intervals: [['09:00', '13:00']] },      // horaires spéciaux
    { date: '2026-06-30', intervals: [['10:00', '12:00']] },      // ouvert un jour férié
    { date: '2026-07-03', closed: true }
  ]
};

const coupe = {
  id: 'coupe',
  duration: 30,       // minutes
  bufferBefore: 0,
  bufferAfter: 10,    // nettoyage
  step: 15,           // un créneau tous les quarts d'heure (la durée par défaut)
  minNotice: 120,     // pas de réservation à moins de 2 h
  horizon: 30         // pas au-delà de 30 jours
};
```

## Calculer les créneaux (sans base)

```js
const { computeSlots } = require('@astratra/booking');

const creneaux = computeSlots({
  resources: [barbier],
  service: coupe,
  from: '2026-06-29T00:00:00Z',
  to: '2026-07-06T00:00:00Z',
  bookings,             // rendez-vous déjà pris
  busy,                 // indisponibilités externes { resourceId, start, end } (agenda, réunion)
  mode: 'each',         // each | any | all
  timeZone: 'Africa/Lubumbashi' // fuseau d'affichage de `local` (celui de la 1re ressource sinon)
});
// → [{ start: '2026-06-29T08:00:00.000Z', end: '…', resourceIds: ['barbier-1'], available: 1,
//      local: { date: '2026-06-29', time: '09:00', offset: '+01:00' } }, …]
```

- `each` : un créneau par ressource ;
- `any` : au moins une ressource libre (« n'importe quel coiffeur ») ;
- `all` : toutes libres en même temps (coiffeur **et** fauteuil, expert à
  Kinshasa **et** salle à Lubumbashi).

## Les règles, qui ne changent pas

1. La prestation tient dans une plage d'ouverture. Les tampons ne servent qu'à
   écarter les autres rendez-vous et peuvent déborder l'horaire.
2. Deux rendez-vous se gênent si leurs plages **tampons compris** se
   chevauchent ; chacun garde les tampons de sa propre prestation.
3. Un créneau est réservable s'il reste au moins `seats` places sur toute sa
   durée, tampons compris.
4. Préavis : début au plus tôt `minNotice` minutes après maintenant. Horizon :
   début au plus tard `horizon` jours après.
5. Priorité pour un jour : exception datée > période fermée > jour férié >
   horaires de la semaine.
6. Changement d'heure, tranché comme Temporal : une heure inexistante
   (02:30 au printemps) avance d'autant (03:30) ; une heure ambiguë (02:30 à
   l'automne) prend la première. Une plage 01:00–04:00 dure donc 2 h la nuit
   du passage à l'heure d'été et 4 h la nuit du retour.

## Réserver, annuler, reporter

```js
const { createBookingService, createPostgresBookingStore } = require('@astratra/booking');

const reservations = createBookingService({
  store: createPostgresBookingStore({ pool }),
  resources: [barbier, barbier2, fauteuil],   // ou async (id) => ressource
  services: { coupe }
});

await reservations.getSlots({ resourceIds: ['barbier-1'], service: 'coupe', from, to });
const rdv = await reservations.book({ resourceIds: ['barbier-1'], service: 'coupe', start, data: { clientId } });
await reservations.book({ anyOf: ['barbier-1', 'barbier-2'], service: 'coupe', start });   // le premier libre
await reservations.book({ resourceIds: ['barbier-1', 'fauteuil-1'], service: 'coupe', start }); // les deux ensemble
await reservations.reschedule(rdv.id, { start: autreDebut });   // l'ancien horaire part dans `history`
await reservations.cancel(rdv.id, { reason: 'client malade' }); // les places se libèrent aussitôt
```

`book` et `reschedule` relisent les rendez-vous **sous verrou**, recalculent
le créneau avec les mêmes règles que `getSlots`, puis écrivent. Erreurs
(`BookingError`, champ `code`) :

| Code | Sens |
| --- | --- |
| `SLOT_TAKEN` | le créneau existe mais n'a plus assez de places |
| `SLOT_UNAVAILABLE` | jamais proposé : hors horaires, hors grille, préavis, horizon, fermeture |
| `BOOKING_NOT_FOUND` | rendez-vous inconnu |
| `BOOKING_CANCELLED` | on ne reporte pas un rendez-vous annulé |
| `RESOURCE_NOT_FOUND` | ressource inconnue |

Un report reprend la prestation du rendez-vous par son id dans `services` ;
si elle n'y est pas, passe `service` à `reschedule`.

## Stockage

| Fabrique | Exclusivité |
| --- | --- |
| `createMemoryBookingStore()` | file d'attente par ressource (un seul processus : tests, outils) |
| `createPostgresBookingStore({ pool, prefix })` | transaction + `SELECT … FOR UPDATE` sur une ligne de verrou par ressource |
| `createMongoBookingStore({ db, prefix, leaseMs, waitMs })` | bail : un document de verrou par ressource (`_id` unique), repris s'il expire ; marche sans jeu de réplicas |

Plusieurs ressources se verrouillent toujours dans le même ordre : deux
réservations croisées ne s'attendent jamais l'une l'autre.

Pour une autre base, fournis `listBookings(resourceId, from, to)`,
`getBooking(id)` et `transaction(resourceIds, travail)`, où `travail(tx)`
s'exécute en exclusivité sur ces ressources et n'écrit rien s'il lève.

## Jours fériés

```js
const { getPublicHolidays, HOLIDAY_COUNTRIES } = require('@astratra/booking');
getPublicHolidays('CD', 2026); // [{ date: '2026-01-01', id: 'new-year', name: 'Nouvel An' }, …]
```

Pays fournis : RDC (`CD`), France (`FR`), Belgique (`BE`). Ce sont des
données : un autre pays (ou une liste officielle qui change) se passe en
`calendars: { CG: (annee) => [...] }` à `computeSlots` ou au service. Vérifie
la liste de ton pays avant la mise en production : un décret peut ajouter un
jour.

## Tests

`npm test` : une semaine de créneaux avec jour férié, congé, horaires
spéciaux et tampons ; préavis et horizon ; Paris aux deux changements d'heure ;
Kinshasa et Lubumbashi ensemble ; capacité ; réservation, double
réservation refusée (20 demandes simultanées, une seule passe), annulation,
report, sur la mémoire, PostgreSQL (pg-mem) et MongoDB (mongodb-memory-server).

PostgreSQL réel (vrais verrous) : `ASTRATRA_TEST_PG_URL=postgresql:///base_jetable npm test`.
Les tables `essai_bookings` et `essai_locks` sont supprimées à la fin.

## Origine

La logique s'inspire des idées de disponibilités de Cal.com (horaires
hebdomadaires, exceptions datées, tampons, préavis, horizon glissant,
places). Aucun code n'en est repris : tout est réécrit ici.
