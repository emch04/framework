# @astratra/loyalty

Deux cartes du commerce de quartier, en règles claires :

- **la carte à tampons** : N visites dans une fenêtre de temps ouvrent droit à
  une récompense, et le compteur repart à zéro dès qu'elle est utilisée ;
- **la carte à quota mensuel** : un abonnement qui donne N passages par mois
  calendaire, remis à zéro le 1er ; au-delà, le passage se paie.

Aucune dépendance. Ce package ne connaît ni ta base, ni tes clients : tu lui
donnes une liste de visites ou de passages, il te rend l'état de la carte.

## Le problème

« Sept coupes, la huitième offerte » paraît simple. En pratique, trois pièges :

- **la fenêtre** : sans limite, un client venu six fois il y a deux ans garde
  son avance pour toujours ;
- **la récompense elle-même** : la visite gratuite ne doit pas compter comme un
  tampon, et le compteur doit repartir à zéro juste après, pas à la fin de la
  fenêtre ;
- **le calendrier** : un cycle ouvert un 30 novembre ne doit pas finir le
  « 30 février » que JavaScript transforme silencieusement en 2 mars.

## Utilisation

```js
const { createStampCard } = require('@astratra/loyalty');

const carte = createStampCard({ threshold: 7, window: { months: 3, days: 15 } });

const etat = carte.evaluate({
  visits: [
    { id: 'rdv-1', date: '2026-01-04' },
    { id: 'rdv-2', date: '2026-01-18' }
    // …
  ],
  reward: client.recompense // { status, cycleStart, visitId } ou null
});
// → { cycleStart, cycleEnd, count, remaining, reached, shouldGrant }
```

- `count` / `remaining` : les tampons du cycle en cours et ce qu'il manque.
- `shouldGrant` : `true` une seule fois par cycle, au moment où le seuil est
  atteint. Inscris alors la récompense avec `cycleStart` pour ne jamais la
  réaccorder sur le même cycle.
- Marque la visite où la récompense est consommée avec `redeemed: true` : elle
  reste dans l'historique mais ouvre un compteur neuf.

## Les règles, qui ne changent pas

1. Le cycle s'ouvre à la première visite comptée et dure la fenêtre, fin exclue.
2. Une visite après la fin ouvre un cycle neuf ; les tampons de l'ancien sont perdus.
3. La visite récompense ne compte pas et remet le compteur à zéro immédiatement.
4. Une récompense déjà inscrite sur un cycle (disponible, réservée, utilisée,
   perdue) ne se réaccorde pas sur ce cycle.
5. Les dates sont des jours civils `AAAA-MM-JJ` : un fuseau horaire ne fait
   jamais changer une visite de cycle.

Statuts de récompense : `available`, `reserved`, `used`, `lost`.

## La carte à quota mensuel

« Cinq coupes par mois pour un forfait » : un abonnement sans nom, porté par un
numéro et un QR, que le commerçant scanne à chaque passage. Les pièges, ici :

- **le mois** : il se compte dans le fuseau du commerce. À 0 h 30 le 1er
  octobre à Paris, il est encore 22 h 30 le 30 septembre en UTC : un serveur
  réglé en UTC compterait le passage sur le mauvais mois. Le fuseau est donc
  **obligatoire** ;
- **le double scan** : deux scans à quelques secondes d'écart, c'est un geste
  répété, pas deux prestations ;
- **le numéro au comptoir** : « a901 », « A000901 » ou « 901 » désignent la
  même carte.

```js
const { createMonthlyPass } = require('@astratra/loyalty');

const abonnement = createMonthlyPass({
  quota: 5,
  timeZone: 'Europe/Paris',
  qrPrefix: 'BCA:',                    // reconnaître ses QR, refuser les autres
  number: { prefix: 'A', digits: 6 }   // A-000123
});

const carte = { status: 'active', uses: [{ date: '2026-09-03T10:00:00Z' }, { date: '2026-09-04T10:00:00Z', cancelled: true }] };

abonnement.evaluate(carte);
// → { month: '2026-09', used: 1, remaining: 4, quota: 5, exhausted: false,
//     active: true, resetsOn: '2026-10-01', recentUses: ['2026-09-03T10:00:00.000Z'] }

abonnement.decideScan(carte);                    // 'count' | 'duplicate' | 'exhausted' | 'suspended'
abonnement.decideScan(carte, new Date(), { force: true });   // après confirmation d'un doublon

abonnement.qrText(jetonSecret);                  // 'BCA:<jeton>'
abonnement.tokenFromQr(texteLuParLaCamera);      // le jeton, ou null
abonnement.parseNumber('a901');                  // 'A-000901'
abonnement.formatNumber(901);                    // 'A-000901'
```

Les règles :

1. Le compteur se relit dans `uses` à chaque fois ; il n'est jamais stocké.
   Un passage `cancelled: true` rend le crédit.
2. Le 1er du mois (fuseau du commerce), la carte revient au quota. Ce qui n'a
   pas été utilisé ne se reporte pas.
3. Quota atteint : `exhausted`, le passage se paie normalement.
4. Deux passages à moins de `duplicateWindowMs` (2 minutes par défaut, 0 pour
   désactiver) : `duplicate`, à confirmer avec `force: true`.
5. Une carte dont `status` n'est pas `'active'` ne compte rien : `suspended`.
6. Le QR porte un jeton secret (16 à 64 caractères `A-Z a-z 0-9 _ -`), jamais
   le numéro : un numéro se devine, un jeton non.

Deux scans simultanés de la même carte (deux téléphones, un double appui) se
règlent côté base : écris le passage seulement si la carte n'a pas changé
depuis sa lecture (un numéro de version), sinon relis-la et redécide.
