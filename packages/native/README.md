# @astratra/native

La plomberie mobile, sans le moteur mobile : **session sécurisée, verrou
biométrique, notifications natives, retour de paiement, état du réseau, mises à
jour à distance, cache de médias**.

Le package ne charge ni `expo-secure-store`, ni `expo-local-authentication`,
ni `expo-web-browser`, ni NetInfo, ni `expo-updates`, ni `expo-file-system`. Il les **reçoit**. Même règle que `@astratra/notify`
avec son transport, et même bénéfice : tout ce qui suit se teste en Node, sans
simulateur ni build natif.

Aucune dépendance à l'exécution.

---

# Session

Le trousseau du téléphone est un module natif : l'importer ici ferait entrer un
build natif dans chaque test, et rendrait le package inutilisable partout où le
module manque — un aperçu navigateur, un client de développement compilé avant
son installation.

Le trousseau est donc injecté. Le contrat est celui d'`expo-secure-store`, noms
de méthodes compris — le renommer aurait obligé chaque appelant à écrire une
enveloppe pour la seule implémentation que tout le monde utilise.

```js
import * as SecureStore from 'expo-secure-store';
import { createSecureSession } from '@astratra/native';

const session = createSecureSession({ keystore: SecureStore, namespace: 'acme' });

await session.save({ accessToken, refreshToken });
const token = await session.getAccessToken();
```

Deux décisions, chacune née d'un vrai défaut.

**Le jeton d'accès est gardé en mémoire.** Lire le trousseau est un aller-retour
natif, et chaque requête a besoin du jeton : un écran de liste et ses douze
requêtes parallèles faisaient douze lectures du Keychain.

**Effacer emporte le drapeau biométrique.** Ce drapeau dit « cette personne a
choisi de déverrouiller par son visage » — il appartient à la session qui l'a
activé. Laissé derrière à la déconnexion, il reste actif pour le compte suivant
sur le même appareil, un inconnu compris.

Un trousseau peut échouer : Keychain verrouillé, permission révoquée, stockage
navigateur désactivé. Une lecture qui lève est répondue « pas de session » — la
personne se reconnecte, ce qui est mauvais, quand un plantage au lancement est
pire.

Deux adaptateurs accompagnent le contrat : `createMemoryKeystore()` pour les
tests, `createWebKeystore(localStorage)` pour l'aperçu navigateur — jamais pour
un build web livré : `localStorage` n'est pas un trousseau, n'importe quel
script de la page le lit.

# Verrou biométrique

Trois faits, et une règle par fait.

```js
import * as LocalAuthentication from 'expo-local-authentication';
import { createBiometricGate } from '@astratra/native';

const gate = createBiometricGate({
  keystore: SecureStore,
  authenticator: LocalAuthentication,
  namespace: 'acme',
  promptMessage: 'Acme'
});

const { supported, enabled } = await gate.read();
await gate.enable();          // demande, PUIS retient
const unlocked = await gate.confirm();
```

**« Pris en charge » demande les deux faits de l'appareil** — un capteur, et une
empreinte enregistrée. Un téléphone avec capteur et rien d'enregistré affiche
l'invite et refuse aussitôt : l'utilisateur y lit une fonction cassée.

**Activer demande d'abord, retient ensuite.** L'inverse laisserait l'application
prétendre un déverrouillage que personne n'a accordé.

**Un drapeau ne survit pas à l'empreinte qu'il désigne.** Si l'empreinte a été
retirée du téléphone depuis, `enabled` retombe à faux tout seul.

**`confirm()` ne propose rien quand le verrou n'a pas été activé** — une invite
biométrique que personne n'a demandée est ce qui fait signaler une application
comme hameçonnage.

Rien ne lève ici. Un capteur peut être occupé, une permission révoquée entre
deux écrans : l'appelant reçoit un état à afficher, jamais une exception à
rattraper.

# Notifications

## Quand demander

L'invite système ne se lève **qu'une fois**. La lever au lancement, avant que la
personne sache ce que l'application envoie, transforme un « non » réflexe en
refus définitif : le système ne redemande jamais, et le seul retour possible est
un détour par les réglages que presque personne ne fait.

```js
decideRegistrationAction({ explicit: false, permission: 'undetermined' }); // 'none'
decideRegistrationAction({ explicit: true,  permission: 'undetermined' }); // 'request'
decideRegistrationAction({ explicit: true,  permission: 'denied' });       // 'open-settings'
decideRegistrationAction({ explicit: false, permission: 'granted' });      // 'register'
```

## Où mène un appui

Une notification porte une route venue du serveur. La suivre à l'aveugle ouvre
des écrans que le destinataire n'a pas à voir : cette route est une donnée du
réseau, et les rôles changent entre l'envoi et l'appui.

Les règles se déclarent **par autorisation**, jamais par exclusion — une liste
de routes interdites admet en silence chaque écran ajouté ensuite et oublié.

```js
const router = createNotificationRouter({
  fallback: '/notifications',
  routes: [
    { pattern: /^\/orders$/, allow: (role) => role === 'seller' },
    { pattern: /^\/billing$/, allow: (role) => role === 'owner', to: '/billing/overview' }
  ],
  actions: { REFUND: (payload) => `/orders/${payload.orderId}/refund` }
});

router.resolve('/orders?from=push', 'courier'); // '/notifications'
```

## La veille au premier plan

Le push traite l'application fermée. Une application **ouverte** ne reçoit
rien : la cloche restait figée jusqu'à ce qu'on quitte l'écran et qu'on y
revienne.

```js
if (shouldPoll(appState, Boolean(user)) ) {
  const items = await fetchNotifications();
  for (const item of freshItems(items, lastSeen)) banner(item);
  lastSeen = nextStamp(items, lastSeen);
}
```

**Le premier relevé ne lève rien** : au démarrage, tout l'historique non lu
« vient d'arriver » du point de vue du téléphone, et vingt bannières d'un coup
font couper les notifications pour de bon. **Le repère ne recule jamais**, sinon
la même notification re-bannère au relevé suivant. **Une date illisible n'est
pas maintenant** — la traiter comme l'instant présent bannèrerait tout
l'arriéré.

## L'interrupteur des réglages

```js
const controller = createPushSettingsController(operations, setSnapshot);
const screen = controller.activate();
// à la sortie de l'écran :
screen.dispose();
```

**Une réponse réseau survit à l'écran qui l'a demandée.** Appuyez, quittez : la
réponse arrive sur un écran disparu et écrase l'état de celui qui a suivi.
Chaque activation reçoit une génération ; une génération qui n'est plus la
courante ne publie rien.

**L'état n'est jamais déduit de l'action** — il est **relu** de l'appareil
ensuite. Supposer « l'activation a réussi, donc c'est actif » est ce qui laisse
un interrupteur allumé au-dessus de notifications éteintes.

# Retour de paiement

```js
const openCheckout = createCheckoutOpener({
  linking: Linking,
  loadBrowser: () => (requireOptionalNativeModule('ExpoWebBrowser') ? require('expo-web-browser') : null)
});

const returned = await openCheckout(url, 'acme://paid');
```

**Le module natif peut ne pas être là.** Un client de développement compilé
avant son installation ne le contient pas, et le seul fait de l'importer lève —
une erreur qu'un `try` rattrape, mais que l'écran rouge affiche quand même. Son
absence est un cas prévu : le navigateur du téléphone prend le relais, le
paiement aboutit, le retour est juste moins fluide.

**La passerelle renvoie vers le site, pas vers l'application.** Sans lien de
retour, la personne reste échouée sur une page web, son achat quelque part
derrière.

`true` signifie **la personne est revenue par le lien de retour**, jamais « le
paiement a réussi ». Seul le serveur le sait, et un client qui en décide seul
finit par offrir quelque chose.

# Effet de verre

```js
resolveGlassMode({ platform, apiAvailable, effectAvailable }); // 'native' | 'fallback'
```

Décidé une fois, pour que toutes les surfaces répondent pareil : un en-tête qui
floute au-dessus d'une carte qui ne floute pas est pire que ni l'un ni l'autre.

# Réseau

```js
import NetInfo from '@react-native-community/netinfo';
import { createConnectivityMonitor } from '@astratra/native';

export const network = createConnectivityMonitor({ netInfo: NetInfo });
network.start();                                  // une fois, au lancement
network.setRecoveryProbe(() => api.request('/health'));

// dans le client HTTP
if (!network.shouldAttemptRequest()) return fromCache();
try { const r = await fetch(url); network.noteTransportSuccess(); return r; }
catch (e) { network.noteTransportFailure(isAbort(e) ? 'timeout' : 'unreachable'); throw e; }

// dans un écran
const offline = useSyncExternalStore(network.subscribe, network.isOffline);
useEffect(() => network.onComeback(reload), []);
```

**Hors ligne veut dire : aucune interface.** `isConnected === false`, rien
d'autre. Un `isInternetReachable` à `null` — le système n'a pas encore tranché,
les premières secondes de chaque lancement — n'est pas une panne : le traiter
comme tel fait clignoter « hors ligne » à chaque ouverture.

**Le « sans Internet » du système n'est pas une panne non plus.** Ce verdict ne
vient pas de votre serveur : sur Android c'est le drapeau « validé » du Wi-Fi,
posé seulement après avoir joint un serveur de Google ; ailleurs NetInfo sonde
lui-même une adresse Google. Sur un Wi-Fi où ce test échoue (DNS du
fournisseur, filtrage, lenteur), le réseau est déclaré mort alors que les
requêtes de l'application passent. Constaté en production : l'application se
disait hors ligne sur le Wi-Fi seul, et ne se croyait en ligne qu'avec les
données mobiles allumées en même temps. L'état reste donc « inconnu », les
requêtes partent, et **ce sont elles qui tranchent**.

**Un échec de transport se retient trente secondes** (`blackoutMs`). Le cas le
plus pénible — le Wi-Fi d'hôtel qui accepte la connexion et ne laisse rien
passer — n'est jamais évident pour le système. Sans cette mémoire, chaque écran
repayait tout le délai d'expiration avant de montrer son cache ; avec, le
premier paie, les suivants affichent tout de suite. N'importe quel appel qui
aboutit l'efface.

**Une expiration n'accuse pas toujours le réseau.** Si le système affirme
qu'Internet est joignable, un serveur lent expire comme un portail captif :
c'est le serveur qui est en cause, et basculer tout le monde hors ligne
servirait du cache périmé à tous les écrans. Un refus de transport, lui, est
formel.

**À l'échéance, on repose la question.** Sans cela, rien ne prévenait les
écrans quand les trente secondes tombaient, et le seul signal de reprise était
le retour de la radio — qui n'était jamais partie. La sonde part une fois ; si
elle réussit, la reprise est annoncée, sinon le constat repart. Rien ne part
quand le système affirme l'absence de réseau.

**Le retour du réseau est un événement, pas un état** (`onComeback`) : c'est
lui qui relance ce qui avait échoué, une seule fois. `refresh()`, pour une
tâche d'arrière-plan qui se réveille, relit le système sans l'émettre — la
tâche va vider la file elle-même.

**Le lien compte à part** (`getConnectionLink()` : `wifi`, `cellular`, `none`,
`unknown`). Passer du Wi-Fi aux données mobiles ne change pas « en ligne », et
change tout pour ce qui se paie au mégaoctet. Traitez `unknown` comme facturé.

Les règles sont aussi exportées seules, pures : `readReachability`,
`readConnectionLink`, `worthAttempting`, `hasComeBack`,
`shouldDeclareTransportDown`.

# Mises à jour à distance

```js
import * as Updates from 'expo-updates';
import { AppState } from 'react-native';
import { createUpdateWatcher } from '@astratra/native';

const watcher = createUpdateWatcher({
  updates: Updates,
  appState: AppState,
  isOnline: network.shouldAttemptRequest,
  pendingWrites: () => outbox.pending,
  onError: (error, { where }) => report(error, where)
});
watcher.start();
```

**Vérifier au lancement, puis au plus une fois par heure** (`checkIntervalMs`),
au retour au premier plan, et jamais hors ligne. Une mise à jour que
l'application ne demande jamais ne sert à rien — c'était le cas.

**Appliquer seulement quand personne ne regarde.** Au passage en arrière-plan,
un délai de grâce de 45 secondes (`graceMs`) : répondre à un SMS et revenir
prend quelques secondes, et recharger pendant cet aller-retour renvoyait la
personne à l'écran de démarrage, sa page perdue. Revenir annule le délai ; un
nouveau départ le recommence en entier.

**À l'échéance, on revérifie.** Sur iOS, un minuteur gelé en arrière-plan part
au retour au premier plan, avant l'événement de changement d'état : sans cette
garde, le rechargement tombait sous les yeux de la personne.

**Jamais avec des écritures en attente.** Recharger en pleine reprise de la
file hors ligne peut rejouer une entrée avant qu'elle soit marquée partie.
L'occasion suivante la posera.

`describeBuild(version)` donne ce que tourne vraiment le téléphone ; son
`release` (`1.2.0+3f2a9c1d`, ou `1.2.0+embedded`) distingue deux mises à jour du
même binaire dans les rapports de plantage.

# Cache de médias

```js
import * as FileSystem from 'expo-file-system/legacy';
import { createMediaCache, contentKey, extensionFor } from '@astratra/native';

const cache = createMediaCache({
  fs: FileSystem,
  directory: `${FileSystem.cacheDirectory}audio/`,
  extensions: ['m4a', 'wav']
});

const uri = await cache.resolve(contentKey('v2', lang, text), async () => {
  const response = await api.raw('/speak', { method: 'POST', body });
  const bytes = await response.arrayBuffer();
  return {
    extension: extensionFor(response.headers.get('content-type'), { 'audio/mp4': 'm4a' }, 'wav'),
    write: (tempUri) => FileSystem.writeAsStringAsync(tempUri, toBase64(bytes), { encoding: 'base64' })
  };
});
```

La première version de ce cache retéléchargeait tout le fichier à chaque
lecture, et laissait chaque copie sous un nom horodaté que plus rien ne
relisait : le dossier grossissait sans fin.

**Une clé stable par contenu.** `contentKey(...parties)` : tout ce qui change
les octets, **version comprise** — quand le serveur change son rendu, la
nouvelle version retire les anciens fichiers. Les parties sont encodées, pas
collées : `('a:b', 'c')` et `('a', 'b:c')` ne partagent pas de clé. 106 bits,
en JS pur (une empreinte native serait asynchrone et ne tournerait pas en Node).

**Écrire à côté, puis déplacer.** Une coupure au milieu de l'écriture laisse un
`.tmp`, jamais un fichier tronqué pris pour valide à la lecture suivante. Deux
appuis sur le même contenu : le déplacement perdant cède au fichier déjà posé.

**Un dossier borné** : 40 fichiers et 60 Mo par défaut (`maxFiles`,
`maxBytes`), les plus anciens partent d'abord. Le plus récent **ne part
jamais**, même trop lourd à lui seul : c'est celui qu'on lit. Un temporaire de
plus de cinq minutes (`abandonedAfterMs`) est le reste d'un téléchargement
coupé ; plus jeune, il est peut-être en cours d'écriture, on n'y touche pas.
Le rangement suit chaque écriture, sans retenir la lecture, un seul à la fois.

Le dossier doit être **à lui seul** : tout ce qui n'y porte pas l'une des
extensions déclarées est traité comme un temporaire abandonné.

L'API historique d'Expo ne sait pas toucher la date d'un fichier sans le
réécrire : l'éviction suit donc l'ordre de téléchargement, pas celui de
lecture. Un fichier très relu finit par partir, puis revient au prochain appui.
