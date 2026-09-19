# @astratra/app-version

Prévenir les utilisateurs d'une appli mobile qu'une **nouvelle version est
sortie dans l'App Store ou le Play Store** : une route publique qui dit quelle
version le magasin propose, **une** notification par version aux seuls
téléphones en retard, et, côté téléphone, un veilleur qui interroge le serveur
au plus toutes les six heures et décide s'il faut un bandeau ou un blocage.

Les mises à jour à distance (OTA) corrigent le JavaScript sans rien demander.
Elles ne remplacent pas le binaire : un module natif, une permission, un
correctif de sécurité du moteur n'arrivent que par le magasin. Et un téléphone
dont le propriétaire n'ouvre jamais le magasin garde sa version pour toujours.

Ni Express, ni Mongo, ni React Native : le stockage des annonces, l'envoi des
notifications, la requête, le disque, la version installée et l'horloge sont
**injectés**. Tout se teste en Node. Aucune dépendance à l'exécution, et
**aucun texte visible dans le paquet** : les messages viennent de l'appelant.

```bash
npm install @astratra/app-version
```

---

# Le manifeste des versions

Une entrée par plateforme, validée **au démarrage** :

```js
const { defineVersionManifest } = require('@astratra/app-version');

const versions = defineVersionManifest({
  ios: { latest: '1.1.4', minimum: '1.0.0', storeUrl: null },
  android: {
    latest: '1.1.4',
    minimum: '1.0.0',
    storeUrl: 'https://play.google.com/store/apps/details?id=com.acme'
  }
});
```

- **`latest`** — la version visible dans le magasin. En dessous, le téléphone
  voit le bandeau et reçoit **une** notification. À monter **après** la revue
  d'Apple ou de Google, jamais avant : une annonce arrivée avant la fiche envoie
  les gens vers l'ancienne version.
- **`minimum`** — en dessous, l'appli bloque et demande la mise à jour. À ne
  monter que pour une raison grave : faille, serveur incompatible.
- **`storeUrl`** — la fiche publique, en `https://`, `itms-apps://` ou
  `market://`. **`null` = rien n'est affiché ni envoyé** pour cette plateforme :
  on n'envoie personne vers une page qui n'existe pas encore.

Une faute de frappe dans `latest` (« 1.2.x ») était silencieuse : la
comparaison répondait « illisible », aucun téléphone n'était prévenu, rien ne
disait pourquoi. `defineVersionManifest` lève maintenant au démarrage — de même
pour une minimale au-dessus de la dernière (tout le monde bloqué, rien à
installer) ou un lien qui n'est pas celui d'un magasin.

# La route publique

**Sans session** : un téléphone trop ancien doit apprendre qu'il doit se mettre
à jour avant même de pouvoir se connecter. Montez-la avant l'authentification.

```js
const { createVersionHandler, toExpressHandler } = require('@astratra/app-version');

const handler = createVersionHandler({ versions });            // { status, headers, body }
app.get('/api/app/version', toExpressHandler(handler, { wrap: (data) => ({ data }) }));
```

La réponse porte `Cache-Control: public, max-age=300` : chaque lancement la lit,
écran de connexion compris, et elle ne change qu'une fois par version. Cinq
minutes de cache partagé soulagent l'API sans retard perceptible. `versions`
peut être une fonction, relue à chaque requête. Hors Express, appelez
`handler()` et recopiez `status`, `headers` et `body`.

# Annoncer une nouvelle version

```js
const {
  createVersionAnnouncer,
  isAnnouncementEnabled,
  startAnnouncementSchedule
} = require('@astratra/app-version');

const announcer = createVersionAnnouncer({
  versions,
  store: announcementStore,                 // voir plus bas
  listDevices: (platform) => devices.find({ platform, enabled: true }),
  languagesFor: async (devices) => langueDesComptes(devices),   // facultatif
  send: (devices, message) => push.sendToDevices(devices, message),
  messages: {
    en: { title: 'New version of Acme', body: 'Version {version} is available.' },
    fr: { title: 'Nouvelle version d’Acme', body: 'La version {version} est disponible.' }
  },
  payload: { category: 'app_update', route: '/update' },
  enabled: () => isAnnouncementEnabled(process.env)
});

startAnnouncementSchedule({ announcer, lock: withJobLock, onError: logger.error });
```

Cinq règles, chacune née d'un vrai défaut.

**Une annonce par plateforme et par version, réservée AVANT l'envoi.** La tâche
tourne sur chaque instance d'une grappe, et après chaque redémarrage. Écrite
après l'envoi, la trace laisse une seconde instance — ou un plantage en plein
envoi — renvoyer la même nouvelle. Réservée d'abord, le pire cas est un envoi
partiel, jamais un doublon : c'est le doublon qui fait couper les notifications.

**En journée seulement** (7 h – 20 h UTC par défaut, `window` pour changer).
Une nouveauté n'a rien d'urgent : elle ne réveille personne. Hors fenêtre, la
tâche attend le passage suivant — rien n'est réservé.

**Aux seuls téléphones en retard.** Un téléphone déjà à jour à qui l'on dit
de se mettre à jour y lit un bogue. Une version **absente** compte comme en
retard : les versions trop anciennes pour la déclarer sont justement celles
qu'il faut prévenir. Une version **illisible** (« dev ») non : c'est une
compilation de développement.

**Dans la langue du compte.** `languagesFor(devices)` renvoie une `Map` (ou un
objet) id d'appareil → langue, pour une langue qui vit sur le compte ; sinon
`device.language` ; sinon `defaultLanguage` (`'en'`). Un envoi par langue et
par paquet de 50. Les textes : un catalogue `messages` (chaînes avec
`{version}` / `{platform}`, ou fonctions), ou une fonction
`translate(language, { version, platform })` qui rend `{ title, body }`. Sans
l'un ni l'autre, ou sans entrée pour la langue par défaut, la création lève.

**Rien sans fiche publique.** `storeUrl` absent ou invalide : rien n'est
réservé, rien n'est envoyé.

Un paquet dont l'envoi lève est compté en échec, et les suivants partent quand
même : la réservation est déjà écrite, lever laisserait tous les autres
téléphones sans nouvelle pour toujours. Une erreur du stockage à la
**réservation**, elle, remonte — on n'envoie jamais sans réservation.

## L'interrupteur

Cette tâche envoie de vraies notifications à de vrais téléphones. Un poste de
développement branché sur la base de production exécutait les tâches planifiées
contre elle. **`enabled` vaut `false` par défaut** ; seule la valeur `true` (ou
une fonction qui rend `true`) l'active — la chaîne `'true'` ne compte pas.

`isAnnouncementEnabled(env, variable = 'ANNOUNCE_VERSIONS')` exige
**exactement** `'1'` : « true », « yes » ou une valeur recopiée d'un autre
projet n'allument rien. Posez la variable **uniquement** dans la configuration
du serveur de production (le fichier du gestionnaire de processus), jamais dans
un `.env` partagé. Passée comme fonction, elle est relue à chaque passage :
l'éteindre ne demande pas de redémarrage.

## Le stockage des annonces

```ts
interface AnnouncementStore {
  claim({ id, platform, version }): Promise<boolean>;   // true = réservée maintenant
  complete(id, { sent, failed, finishedAt }): Promise<void>;
}
```

`claim` doit être **atomique entre instances** : une clé unique sur `id`
(`"android:1.2.0"`). Avec Mongo, `_id: id`, et une erreur `11000` répond
`false` :

```js
const announcementStore = {
  async claim({ id, platform, version }) {
    try { await Announcements.create({ _id: id, platform, version }); return true; }
    catch (error) { if (error.code === 11000) return false; throw error; }
  },
  complete: (id, outcome) => Announcements.updateOne({ _id: id }, { $set: outcome })
};
```

`createMemoryAnnouncementStore()` sert les tests (et expose `get(id)`).

## La planification

`startAnnouncementSchedule({ announcer, intervalMs = 30 min, lock, onError })`
lance `announcer.run()` à intervalle, sous le verrou partagé de l'appli s'il est
fourni (`lock(name, ttlMs, fn)`, durée = 80 % de l'intervalle). La réservation
suffit contre les doublons ; le verrou évite seulement à N instances de lister
tous les appareils à la même seconde. Les erreurs vont à `onError`, jamais en
rejet non géré. Rend `{ tick, stop }`.

# Côté téléphone

```js
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import { AppState, Platform } from 'react-native';
import { useSyncExternalStore } from 'react';
import { createStoreVersionWatcher } from '@astratra/app-version';

export const storeVersion = createStoreVersionWatcher({
  fetchVersions: async () => (await api.get('/app/version')).data,
  storage: AsyncStorage,
  installedVersion: () => Application.nativeApplicationVersion,
  platform: Platform.OS,
  isOnline: () => connectivity.isOnline(),
  onForeground: (listener) =>
    AppState.addEventListener('change', (state) => state === 'active' && listener()),
  namespace: 'acme'
});

storeVersion.start();            // une fois, à la racine

const { status, info, banner } = useSyncExternalStore(storeVersion.subscribe, storeVersion.getSnapshot);
```

`installedVersion` doit rendre la version du **binaire** — celle que le magasin
connaît — pas celle d'un paquet OTA.

**Quatre états** : `'up_to_date'`, `'available'` (bandeau), `'required'`
(blocage), `'unknown'`. « Inconnu » quand on ne peut rien affirmer — version
illisible, pas de réponse — **et quand il n'y a pas de lien valide** : sans
fiche où envoyer la personne, un bandeau ou un blocage ne ferait que la
coincer. Une minimale illisible ou absente ne bloque personne. Une version
installée plus récente que la dernière publiée (compilation de test) est à jour.

**Le bandeau refermé l'est pour UNE version.** `dismiss(version)` retient la
version annoncée ; le bandeau revient quand une version plus récente sort. Si
le serveur revient en arrière, il reste fermé. Une trace illisible ne le fait
pas taire. Le blocage, lui, ne se referme pas.

**Au plus une vérification toutes les six heures**, comptées depuis la dernière
réponse, d'un lancement à l'autre. Jamais hors ligne. Une horloge remise en
arrière ne tait pas la vérification pendant des mois. `check({ force: true })`
sert l'écran ouvert par la notification : il vient d'être annoncé, il doit dire
vrai — mais il ne force rien hors ligne.

**Silence hors ligne, dernière réponse sur le disque.** Une requête qui échoue
ne lève jamais : on garde ce qu'on savait. La réponse est copiée sur le disque
avec son heure, pour un démarrage sans réseau. Un disque illisible vaut une
première ouverture. Les clés (`<namespace>.storeVersion.copy` et
`.dismissed`) sont propres à l'appareil, pas au compte : c'est le téléphone qui
est en retard.

Le paquet n'a **aucun composant d'interface** : bandeau et écran de blocage
vivent dans votre kit d'interface. N'ouvrez `info.storeUrl` que via ces règles :
`isValidStoreLink` refuse tout ce qui n'est pas un magasin, même venu de votre
serveur.

# Comparer des versions

`compareVersions(a, b)` rend `-1`, `0`, `1`, ou `null` si l'une est illisible.
**Nombre par nombre** : en texte, « 1.10.0 » passait avant « 1.9.3 ». Accepte
`v1.2`, `1.2.3.4`, les préversions semver (`1.2.0-beta.10` après
`1.2.0-beta.9`, toutes avant `1.2.0`) ; ignore les métadonnées de compilation
(`+45`). `isBehind(installee, latest)` est la question du serveur (absente =
en retard, illisible = non, `latest` illisible = personne).

# API

| Export | Rôle |
| --- | --- |
| `parseVersion`, `compareVersions`, `isBehind`, `isValidStoreLink` | versions et liens |
| `defineVersionManifest`, `PLATFORMS` | le manifeste, validé au démarrage |
| `createVersionHandler`, `toExpressHandler`, `DEFAULT_MAX_AGE_SECONDS` | la route publique |
| `createVersionAnnouncer`, `createMemoryAnnouncementStore`, `announcementId` | l'annonce unique |
| `isAnnouncementEnabled`, `isWithinDaytime`, `DEFAULT_WINDOW`, `DEFAULT_BATCH_SIZE`, `DEFAULT_ENV_VARIABLE` | l'interrupteur et la fenêtre |
| `startAnnouncementSchedule` | la tâche planifiée |
| `versionStatus`, `isBannerVisible`, `shouldCheckStore`, `infoForPlatform`, `readStoreCopy`, `STORE_CHECK_INTERVAL_MS` | les règles du téléphone |
| `createStoreVersionWatcher` | le veilleur du téléphone |

Types complets dans `src/index.d.ts`.
