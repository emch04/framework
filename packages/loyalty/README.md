# @astratra/loyalty

La carte à tampons du commerce de quartier, en règle claire : **N visites dans
une fenêtre de temps ouvrent droit à une récompense**, et le compteur repart à
zéro dès que la récompense est utilisée.

Aucune dépendance. Ce package ne connaît ni ta base, ni tes clients : tu lui
donnes une liste de visites, il te rend l'état de la carte.

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
