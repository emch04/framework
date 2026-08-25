# @astratra/pdf

Deux problèmes de PDFKit, résolus une fois pour toutes : du texte qui déborde de
sa case, et des tableaux qui se coupent au mauvais endroit.

Ce package **n'importe pas PDFKit**. Tu lui passes ton document, il travaille
dessus. Aucune dépendance à l'exécution.

## Le texte qui déborde

PDFKit, à qui l'on donne une position absolue sans largeur, laisse la chaîne
courir jusqu'au bord de la page puis la replie — et la ligne suivante se pose
par-dessus ce qui était dessous. C'est ainsi qu'un nom d'école trop long passe
sous le bandeau du titre, et qu'un libellé d'article se pose sur la colonne des
prix.

Donner une largeur ne suffit pas : depuis la 0.18, PDFKit ignore
`lineBreak: false` dès qu'une largeur est fournie, replie quand même, et son
option `ellipsis` ne se déclenche jamais.

```js
const { fitText, line } = require('@astratra/pdf');

// Coupé, points de suspension compris, mesuré avec la police ACTIVE.
line(doc, school.name, 40, 100, 195);
```

Utilise `line` partout où la valeur vient de données que tu ne contrôles pas :
un nom, un libellé, une adresse. Bornée et coupée, elle ne peut plus mordre sur
sa voisine.

### Pourquoi la mesure porte sur la hauteur

`fitText` juge en demandant « est-ce que ça tient encore sur UNE ligne ? », pas
en comparant des largeurs. Le replieur de PDFKit accumule la largeur mot à mot
et casse une ligne qui tient pourtant au point près selon la mesure d'ensemble.
La hauteur est la seule question dont la réponse correspond à ce qui est
réellement dessiné — et elle vaut pour toutes les versions.

La coupe se fait par dichotomie : une recherche linéaire ferait un appel aux
métriques de police par caractère, et ces documents ont des centaines de
cellules.

## Le tableau qui se pagine

```js
const { drawTable } = require('@astratra/pdf');

const { y } = drawTable(doc, {
  x: 40, y: 170, width: 515,
  columns: [
    { key: 'subject', label: 'MATIÈRE', width: 200 },
    { key: 'score',   label: 'NOTE',    width: 60, align: 'right',
      format: (v) => `${v} / 20` },
    { key: 'comment', label: 'APPRÉCIATION', wrap: true, fontSize: 7 },
  ],
  rows: results,
  // Réserve la place du bloc de synthèse qui suit.
  bottom: doc.page.height - 200,
  zebra: '#FAFAFA',
});
```

Trois comportements, chacun appris à la dure :

**L'en-tête se redessine sur chaque page.** Sinon la page deux est un mur de
chiffres sans étiquette.

**La hauteur d'une rangée suit sa cellule la plus haute.** Une appréciation
d'enseignant est une information ; la tronquer la perdrait. C'est le rôle de
`wrap: true` — tout le reste est coupé, parce qu'une valeur qui grandit en
silence est une valeur qui chevauche.

**Une rangée ne chevauche jamais une coupure de page.** La moitié en bas d'une
page et la moitié en haut de la suivante se lisent comme deux rangées
différentes.

`bottom` est l'autre moitié de cette dernière règle : il réserve la place de ce
qui vient **après** le tableau. Sans lui, un bloc de totaux part sur une page à
lui tout seul, ou pire, sur le pied de page.

Les colonnes sans `width` se partagent ce qui reste du cadre — déclarer chaque
largeur à la main est la façon dont un tableau cesse de faire la somme de son
propre cadre après une modification.

`drawTable` renvoie `{ y, pages, rows }` : `y` est le curseur pour la suite.

## Le bloc qui ne se coupe pas

```js
const { keepTogether } = require('@astratra/pdf');

// Un panneau de synthèse, une ligne de signature, un total.
let y = keepTogether(doc, { y: cursor, height: 130 });
doc.rect(350, y, 205, 60).stroke();
```

La moitié d'un bloc en bas d'une page est pire qu'une coupure avant lui.

## Ce que ce package ne fait pas

- Il ne **dessine pas** tes documents : facture, reçu, bulletin, c'est ton métier.
- Il n'impose ni police, ni couleur, ni format de page.
- Il n'importe pas PDFKit — c'est une dépendance de pair, optionnelle.
- Il ne génère ni QR code, ni code-barres, ni image.

## Tests

```bash
npm test --workspace @astratra/pdf
```

Les tests tournent sur un vrai document PDFKit : chaque affirmation porte sur ce
que PDFKit fait réellement des métriques de police, pas sur notre arithmétique.
