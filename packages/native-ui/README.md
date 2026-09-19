# @astratra/native-ui

Le kit d'interface mobile : **le verre liquide d'Apple sur iOS, une surface
visible sur Android**, des boutons en verre, des cartes pâles, des barres qui se
replient au défilement, une barre d'onglets façon Instagram, un en-tête
repliable, et le rendu propre des réponses d'une IA.

Pour React Native / Expo. Pas d'étape de build, pas de JSX : le source est du
CommonJS écrit avec `createElement`, comme `@astratra/react`, et Metro le prend
tel quel.

```sh
npm install @astratra/native-ui
npx expo install expo-glass-effect expo-blur expo-linear-gradient react-native-reanimated
```

Dépendances en `peerDependencies` : `react`, `react-native`,
`react-native-reanimated`, `expo-glass-effect`, `expo-blur`,
`expo-linear-gradient`. Une seule dépendance réelle : `@astratra/native`, dont
la règle `resolveGlassMode` décide du verre — elle n'est pas recopiée ici.

Rien n'est écrit en dur : ni texte (les libellés sont des props), ni icône (ce
sont des nœuds ou des fonctions passés par l'application), ni navigation, ni
retour haptique (`onHaptic`).

## Deux entrées

| Import | Contenu | Charge react-native ? |
| --- | --- | --- |
| `@astratra/native-ui` | les composants **et** toutes les règles | oui |
| `@astratra/native-ui/logic` | les règles seules, fonctions pures | non — Node pur |

La logique est séparée des composants pour se tester à sec : ce que fait un
composant se décide dans une fonction pure (quand replier, quelle largeur de
colonne, quel poids de teinte), le composant ne fait que la rendre.

```js
// Un serveur, un script, un test : aucune dépendance mobile.
const { parseMarkdown, measureColumns } = require('@astratra/native-ui/logic');
```

---

# Le verre

## La règle : le verre d'Apple sur iOS, une surface visible ailleurs

`getGlassMode()` interroge `resolveGlassMode` de `@astratra/native`, une fois
pour toute l'application. Seule la réponse `'native'` (Liquid Glass, iOS 26+)
donne le `GlassView` d'Apple.

Partout ailleurs — Android, un iPhone plus ancien — le kit rend une **surface
visible**, pas une imitation. Android avait d'abord reçu son flou natif
(`dimezisBlurView`) : il fonctionnait, mais imitait un matériau qui n'existe pas
chez lui, et chaque surface sortait d'un gris dense et opaque. Android dit
« surface posée » avec un fond, un rayon, une élévation : c'est ce qu'il reçoit.

**Le poids réel de la teinte.** Mesuré au pixel : un `GlassView` teinté de blanc
à 0,4 laisse un fond clair… inchangé. Apple ne peint pas la teinte, il en module
son dépoli. La peindre telle quelle sur Android donnait des panneaux nettement
plus laiteux qu'iOS. Hors du verre d'Apple, une teinte translucide est donc
peinte au **quart** de son poids (`tintAtAppleWeight`) ; un bouton (verre
interactif) reçoit en plus le givre d'Apple, `1 − 0,6 × (1 − α)`. Une couleur
opaque n'est pas une teinte mais de la peinture : elle est laissée telle quelle.

**L'ombre suit la règle d'iOS.** iOS calcule l'ombre sur la silhouette alpha :
un conteneur presque transparent n'en projette aucune. Android dessine toujours
le rectangle plein — un cadre fantôme autour de chaque panneau. Hors du verre
d'Apple, un conteneur perd donc son ombre (`surfaceStyleOffApple`) ; un bouton,
dont le givre est un vrai fond, la garde.

## GlassSurface, GlassGroup

```js
import { GlassSurface, GlassGroup } from '@astratra/native-ui';

<GlassSurface tintColor="rgba(255,255,255,0.4)" style={{ borderRadius: 24, padding: 16 }}>
  <Text>Panneau flottant</Text>
</GlassSurface>

<GlassGroup spacing={8} style={{ flexDirection: 'row' }}>
  <GlassButton …/>
  <GlassButton …/>
</GlassGroup>
```

`GlassGroup` est un `GlassContainer` sur iOS (les verres voisins fusionnent) ;
ailleurs, l'espacement devient un `gap` — un `View` nu collait les éléments.

## GlassButton

Un objet pris dans un glaçon : le verre a un reflet en haut, un pied plus dense,
et **aucun trait** autour — un filet blanc et un contour d'encre se lisaient
comme « de la glace en plastique ». Trois couches, dans cet ordre : la teinte,
le reflet, le contenu. Le contenu passe au-dessus du reflet, sinon le voile
éteint l'icône.

```js
import { GlassButton } from '@astratra/native-ui';

<GlassButton accessibilityLabel={t('back')} onPress={router.back}>
  <BackIcon />
</GlassButton>

<GlassButton pill tint="#3b6cf0" accessibilityLabel={t('send')} onPress={send} size={40}>
  <Text style={{ color: '#fff' }}>{t('send')}</Text>
</GlassButton>
```

Sur une page claire, le verre est `clear` (le `regular` rendait les boutons gris
et ternes sur un vrai iPhone) ; en sombre, `regular`. La lueur qui détache
l'icône n'existe que sous le verre d'Apple : Android en ferait un halo gris.

## PaleCard, TappableCard

Le verre sur les cartes du **contenu** a été jugé laid sur un vrai téléphone :
reflets, flou, ombre flottante. La règle : le verre reste à ce qui flotte et à
ce qu'on touche ; le contenu reçoit des cartes pâles, plates, de leur couleur —
un mélange **opaque** de la teinte dans le fond de page, en léger dégradé, sans
filet ni ombre.

```js
import { PaleCard, TappableCard, usePaleCardColors } from '@astratra/native-ui';

<PaleCard tint={colors.accent} pageBackground={colors.background} ink={colors.text}>
  <Text>Contenu</Text>
</PaleCard>

// Ce qu'on touche : verre interactif sur iOS, carte pâle ailleurs.
<Pressable onPress={open}>
  <TappableCard tint={colors.accent}>
    <Text>Une suggestion</Text>
  </TappableCard>
</Pressable>

// Le même fond pâle pour autre chose qu'une carte.
const { fill } = usePaleCardColors({ tint: colors.accent });
```

---

# Les barres qui flottent

## useCollapsingBar

La règle d'Instagram : on descend, la barre rapetisse ; on remonte, elle revient.
Un tremblement de moins de 8 points ne compte pas, et tout en haut de la page la
barre est toujours pleine (le rebond d'iOS ne la replie pas). Le sens est
comparé au dernier point de décision, pas à l'image précédente : un défilement
lent finit par compter.

```js
import { useCollapsingBar, TabBar } from '@astratra/native-ui';

const { collapse, onScroll } = useCollapsingBar();

<ScrollView onScroll={onScroll} scrollEventThrottle={16}>…</ScrollView>
<TabBar collapse={collapse} … />
```

`collapse` glisse de 0 (pleine) à 1 (repliée) sur le fil de l'interface, sans
rerendre l'écran. Avec « Réduire les animations », la barre ne bouge pas.

## TabBar

La pastille active glisse jusqu'à l'onglet touché, et la page ne s'ouvre qu'une
fois la pastille presque arrivée (`openDelay`, 180 ms) : ouverte dans la même
image, elle couvrait la barre et le glissement n'était jamais vu. Un onglet
central (`centerKey`) monte au-dessus de la barre et **ne prend jamais la
pastille** : il ouvre. La barre se replie au défilement et grossit jusqu'à 12 %
sur les grands écrans, jamais en dessous de sa taille de référence. Verre du
Dock sur iOS, carte claire sur Android.

```js
import { TabBar } from '@astratra/native-ui';
import { useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';

const tabs = [
  { key: 'home', label: t('tabs.home'), icon: ({ color, size }) => <HomeIcon color={color} size={size} /> },
  { key: 'inbox', label: t('tabs.inbox'), badge: unread, icon: … },
  { key: 'assistant', label: t('tabs.assistant'), icon: … },
  { key: 'more', label: t('tabs.more'), icon: … }
];

<TabBar
  tabs={tabs}
  activeKey="home"
  centerKey="assistant"
  renderCenter={({ size }) => <AssistantOrb size={size} />}
  onSelect={(tab) => router.navigate(`/${tab.key}`)}
  collapse={collapse}
  bottomInset={insets.bottom}
  onHaptic={() => Haptics.selectionAsync()}
  useFocusEffect={useFocusEffect}
/>
```

`useFocusEffect` : quand la barre est rendue dans chaque écran, c'est au retour
sur l'écran que la pastille doit revenir à l'onglet de l'écran. Sans lui, elle se
recale quand `activeKey` change.

## FloatingPagination

La pagination d'une liste en pilule flottante, au même endroit et avec le même
repli que la barre d'onglets. Réserver `paginationReserve(insets.bottom)` sous la
liste, pour que sa dernière ligne passe au-dessus de la pilule.

```js
import { FloatingPagination, paginationReserve } from '@astratra/native-ui';

<FlatList contentContainerStyle={{ paddingBottom: paginationReserve(insets.bottom) }} … />
<FloatingPagination
  page={page}
  totalPages={pages}
  canPrevious={page > 1}
  canNext={page < pages}
  onPrevious={() => setPage(page - 1)}
  onNext={() => setPage(page + 1)}
  previousLabel={t('previous_page')}
  nextLabel={t('next_page')}
  collapse={collapse}
  bottomInset={insets.bottom}
/>
```

`bottom` la pose au-dessus d'un bouton déjà fixé au pied de la page.

## CollapsibleScreen, CollapsibleHeader, useCollapsibleHeader

En descendant dans une page, tout partait — le titre, le retour — et on ne
savait plus où l'on était. Désormais le bouton retour et les actions restent
fixes, le grand titre défile, et dès qu'il est passé une petite barre floutée
apparaît avec le nom de la page. Sous la barre, **un fondu et non une ligne**.
Sur iOS, le flou du système ; sur Android, un dégradé de la couleur de la page,
plus léger et plus court (son flou sortait « sale »).

```js
import { CollapsibleScreen, GlassButton } from '@astratra/native-ui';
import MaskedView from '@react-native-masked-view/masked-view';

<CollapsibleScreen
  title={t('schools.title')}
  largeTitle={<Text style={styles.largeTitle}>{t('schools.title')}</Text>}
  leading={<GlassButton accessibilityLabel={t('back')} onPress={router.back}><BackIcon /></GlassButton>}
  actions={<GlassButton accessibilityLabel={t('add')} onPress={add}><PlusIcon /></GlassButton>}
  topInset={insets.top}
  pageBackground={colors.background}
  MaskedView={MaskedView}
>
  {rows}
</CollapsibleScreen>
```

`MaskedView` est facultatif : sans lui, le flou d'iOS s'arrête au bord de la
barre et c'est la couleur de la page qui porte le fondu.

Pour une liste virtualisée, poser l'en-tête soi-même :

```js
const header = useCollapsibleHeader({ topInset: insets.top });

<FlatList
  onScroll={header.onScroll}
  scrollEventThrottle={16}
  contentContainerStyle={{ paddingTop: insets.top + HEADER_BAR_HEIGHT }}
  ListHeaderComponent={<View onLayout={header.onListTitleLayout}>{largeTitle}</View>}
  …
/>
<CollapsibleHeader title={title} scrollY={header.scrollY} threshold={header.threshold} topInset={insets.top} />
```

---

# Les réponses d'une IA

## MarkdownView

Un modèle écrit du Markdown ; l'écran l'affichait brut, étoiles comprises.
`parseMarkdown` est une fonction pure (aucune bibliothèque de rendu Markdown ne
se teste à sec ni ne garantit React 19), et `MarkdownView` n'est qu'un parcours
de ses blocs.

```js
import { MarkdownView } from '@astratra/native-ui';
import * as Clipboard from 'expo-clipboard';

<MarkdownView
  content={message.text}
  plain={message.mine}
  onCopyCode={(code) => Clipboard.setStringAsync(code)}
  copyLabel={t('copy')}
  copyIcon={<CopyIcon />}
  copiedIcon={<CheckIcon />}
  styles={{ body: { color: colors.text } }}
/>
```

Ce que l'analyseur garantit, chaque règle née d'un défaut vu à l'écran :

- **une liste numérotée continue** malgré les puces glissées sous chaque étape —
  le modèle écrit « 1. » partout, l'écran affichait « 1. 1. 1. » ;
- **les traits `---` sont ignorés** — ils s'affichaient en trois tirets ;
- une étoile perdue ne met pas la suite du message en gras ;
- le tiret bas d'un identifiant (`final_grade`) n'est pas de l'italique ;
- un bloc de code sans clôture s'arrête en fin de message, sans rien avaler ;
- le message de la personne elle-même (`plain`) reste tel qu'elle l'a tapé.

## Les tableaux : measureColumns

Chaque cellule était un texte libre : React Native répartissait la place rangée
par rangée, et l'en-tête ne tombait plus en face de ses valeurs. Une colonne a
désormais **une** largeur, calculée une fois pour tout le tableau :

- mesurée sur le **texte visible** (« **Starter** » sans ses étoiles) ;
- jamais sous son mot le plus long — un mot n'est jamais coupé au milieu ;
- plafonnée, pour qu'une phrase revienne à la ligne au lieu d'étirer la colonne ;
- agrandie avec la **taille de texte choisie dans les réglages du téléphone** ;
- arrondie sur la grille de pixels de l'écran, sinon les filets bavent ;
- étirée au prorata jusqu'à la largeur disponible ;
- alignée à droite quand toutes ses valeurs sont des nombres (montants en toute
  devise, pourcentages, notes sur 20).

```js
const { widths, numeric } = measureColumns(header, rows, {
  targetWidth: 320,
  fontScale: PixelRatio.getFontScale(),
  round: PixelRatio.roundToNearestPixel
});
```

Un voile en dégradé signale qu'un tableau trop large continue à droite : sans
lui, une colonne coupée par le bord se lisait comme une colonne vide.

## La question en haut, la réponse dessous

Quand on envoie un message, le fil remonte pour poser la question en haut de
l'écran, et la réponse s'écrit dessous — au lieu de suivre le bas pendant
qu'elle arrive, ce qui faisait sauter l'écran à chaque ligne.

```js
import { anchorOffset, reserveBelowQuestion } from '@astratra/native-ui';

// La réserve sous la question, mesurée sur le VRAI contenu (réserve exclue).
const reserve = reserveBelowQuestion({ viewportHeight, contentHeight, anchorY });
listRef.current.scrollToOffset({ offset: anchorOffset(anchorY) });
```

Avec cette réserve, le défilement maximal vaut exactement la position de la
question, que la réponse s'allonge ou raccourcisse ; elle tombe à zéro dès que la
réponse remplit l'écran.

---

# Tests

```sh
npx jest packages/native-ui
```

- **La logique pure** se teste en Node, sans rien simuler.
- **Les composants** sont montés avec `react-dom` dans `jsdom`, sur des doublures
  des modules natifs (`test/rn.js`) qui rendent chaque composant hôte en élément
  portant ses props. On vérifie ce que le doigt et le lecteur d'écran
  rencontrent — rôles, états, libellés, ordre des couches, ce qu'un appui
  déclenche — sur iOS 26 et sur Android. Jamais des pixels : un rendu sur
  appareil reste à faire.
- `jsdom` 30 dépend d'un module ES seul, que le chargeur de jest ne sait pas
  lire : il est chargé par le `require` natif de Node (Node ≥ 22.3 pour les
  tests).
