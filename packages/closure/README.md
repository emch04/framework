# @astratra/closure

Fermer une période **volontairement** : une liste de clôture portée par des
humains, et une archive qui ne transporte jamais un identifiant de connexion.

Année scolaire, exercice comptable, saison, campagne : tout produit à périodes
finit par les clore. Et la clôture commence presque toujours comme une échéance
subie — une tâche passe à minuit et ferme la période quand une condition tient.
Personne ne voit ce qui manque, et personne ne décide vraiment.

Aucune dépendance à l'exécution. Logique pure : ton contrôleur compte, ce
package juge.

## La liste de clôture

```js
const { createClosureChecklist } = require('@astratra/closure');

const cloture = createClosureChecklist([
  { id: 'deliberations',   label: 'Délibérations à trancher',    blocking: true },
  { id: 'absences',        label: 'Absences sans justificatif',  blocking: false },
  { id: 'impayes',         label: 'Frais impayés',               blocking: false },
]);

// Ton contrôleur compte ce qui reste ; la liste juge.
const liste = cloture.build({ deliberations: 0, absences: 3, impayes: 12 });
// { items: [...], canClose: true, remaining: 2, blocking: 0 }
```

### Bloquant contre reconnu — la distinction qui porte tout

Certains points **interdisent** de fermer : une délibération non tranchée engage
l'avenir d'un enfant. D'autres méritent seulement d'être **vus** : un impayé se
négocie et se reporte.

Fermer une période en laissant des impayés est légitime. Le faire **sans
l'avoir vu** ne l'est pas. C'est le rôle de la reconnaissance :

```js
cloture.canCloseWith(liste, []);
// { ok: false, reason: 'unacknowledged', unseen: ['absences', 'impayes'] }

cloture.canCloseWith(liste, ['absences', 'impayes']);
// { ok: true }
```

Deux règles tenues par les tests :

**Aucune reconnaissance ne passe au-dessus d'un point bloquant.** Cocher toutes
les cases ne ferme pas une période dont une délibération reste ouverte.

**Cocher d'avance ne pré-approuve rien.** Une reconnaissance pour un point qui
n'en demande pas est ignorée, pas récompensée — sinon on cocherait tout au
1er septembre pour être tranquille en juin.

## L'archive

Une archive se transmet, se range, parfois s'envoie par courriel. Deux règles,
apprises au prix fort :

### Ce qui n'y entre jamais

Mots de passe, jetons, clés d'API : rien de ce qui permet de se connecter à la
place de quelqu'un. Le nettoyage se fait **à la frontière de l'archive** —
plutôt que de faire confiance à chaque lecteur pour avoir bien choisi ses
champs. C'est la seule version qui survit au prochain qui ajoute une collection.

```js
const { createArchiveBuilder, createScrubber } = require('@astratra/closure');

const builder = createArchiveBuilder({
  scrubber: createScrubber({ alsoNever: ['activationCode'] }),
  sections: [
    { name: 'students', read: (scope) => Student.find({ school: scope.school }).lean() },
    { name: 'results',  read: (scope) => Result.find({ year: scope.yearId }).lean() },
    { name: 'payments', read: (scope) => paymentsCollection.find({ year: scope.yearId }).toArray() },
  ],
});

const archive = await builder.build({ yearId, school });
// { builtAt, sections, counts, failed: [], complete: true }
```

### Une section en échec ne vide pas l'archive — et elle est nommée

Les sections sont lues séparément. Un lecteur qui lève est consigné dans
`failed` avec sa raison, et le reste de l'archive se construit quand même. Le
rapport dit exactement ce qui est dedans et ce qui n'y est pas — une archive à
laquelle il manque une section **en silence** a l'air complète et ne l'est pas.

## Ce que ce package ne fait pas

- Il ne **compte** rien : les requêtes qui dénombrent ce qui reste sont à toi.
- Il ne **stocke** pas l'archive — écrire le fichier, le chiffrer, lui donner
  une durée de vie, c'est ta décision.
- Il ne connaît ni les écoles, ni les exercices comptables : les points de
  contrôle et les sections sont ton vocabulaire.

## Tests

```bash
npm test --workspace @astratra/closure
```
