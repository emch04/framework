# @astratra/native

La plomberie mobile, sans le moteur mobile : **session sécurisée, verrou
biométrique, notifications natives, retour de paiement**.

Le package ne charge ni `expo-secure-store`, ni `expo-local-authentication`,
ni `expo-web-browser`. Il les **reçoit**. Même règle que `@astratra/notify`
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
