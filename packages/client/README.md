# @astratra/client

La plomberie côté client, faite une fois : **session, garde de route, règles de
mot de passe, file hors ligne**.

Rien de spécifique à un framework — c'est de la logique pure, testable sans
navigateur. Pour les liaisons React (contextes, hooks, `RequireAuth`), voir
`@astratra/react`.

Aucune dépendance à l'exécution.

---

# Le tableau de bord, déclaré en données

Un tableau de bord qui code ses tuiles en dur sert exactement un rôle. Déclaré
en **données** — id, chemin, rôles —, il en sert autant que le produit en a, et
ajouter un écran devient ajouter une ligne.

```js
const catalog = createToolCatalog([
  { id: 'orders', path: '/orders', roles: ['owner', 'seller'], endpoint: '/orders' },
  { id: 'billing', path: '/billing', roles: ['owner'] }
]);

catalog.forRole('seller');            // ce que ce rôle voit, dans l'ordre déclaré
catalog.needsContext(billing);        // true : pas d'endpoint, il faut choisir d'abord
```

**L'accès se déclare par outil, et se refuse par défaut.** Un rôle absent de la
liste — y compris l'absence de rôle, ce à quoi ressemble une session à moitié
restaurée — est refusé. Lister qui est *interdit* admet en silence chaque rôle
ajouté plus tard.

**Ce n'est pas une frontière de sécurité.** Cela décide ce qu'un écran
**propose** ; le serveur décide ce qu'il accorde. Cacher une tuile interdite
évite à quelqu'un un écran qui ne ferait que lui répondre en erreur ; ça
n'arrête personne de déterminé.

## Lire une charge utile qu'on n'a pas dessinée

Un écran générique — « montre-moi ce qu'il y a derrière cet outil » — fait face
à un point d'entrée qui répond comme il veut : un tableau nu, un tableau
enveloppé, ou un objet seul pour une route de détail.

```js
readResourceItems({ orders: [...] });   // le tableau, où qu'il soit
readResourceTitle(row);                 // fullName › name › title › … › id
```

Les replis sont ordonnés par ce qui identifie le mieux une ligne pour un
humain : un nom complet vaut mieux qu'un e-mail, un e-mail vaut mieux qu'un
identifiant. L'identifiant est le dernier recours — « 68f3c1a » ne dit rien à
personne.

# Réglages groupés, et où l'on atterrit

```js
const menu = createSettingsMenu({
  groups: ['account', 'shop', 'support'],
  sectionGroups: { profile: 'account', billing: 'shop' }
});

const home = createHomeRoutes({ routes: { owner: '/dashboard' }, fallback: '/home' });
```

**L'ordre est celui déclaré**, pas celui dans lequel les sections arrivent : un
écran de réglages qui se réorganise entre deux chargements désoriente.

**Une section inconnue est quand même affichée.** Jeter ce que la table ignore
fait disparaître de l'application, sans erreur nulle part, toute section
ajoutée ensuite. Mal rangée est un défaut cosmétique ; invisible est une
fonctionnalité manquante.

**Le repli d'accueil doit rester une page qu'un rôle inconnu a le droit de
voir.** Sans cette table, tout le monde retombait sur la page publique de
pré-connexion — et se faisait renvoyer vers la connexion une seconde après
s'être authentifié. Pointer le repli vers un tableau de bord du personnel
transformerait un oubli de correspondance en fuite d'accès.

# Session

Rester connecté sans que l'utilisateur le remarque.

Les jetons d'accès expirent exprès — leur courte durée de vie est ce qui limite
les dégâts d'un vol. Le prix : chaque client doit gérer l'instant de
l'expiration — attraper le 401, renouveler la session, rejouer la requête, sans
qu'un écran de connexion surgisse au milieu d'une sauvegarde.

Chaque client réécrit cette logique, et les trois mêmes bugs reviennent.

## Les trois bugs

**La ruée sur le renouvellement.** Cinq requêtes échouent ensemble quand le
jeton meurt ; cinq renouvellements partent en course, et quatre consomment un
jeton de rafraîchissement tourné qui n'est plus valable — déconnectant
l'utilisateur au moment précis où tout était rattrapable. Le renouvellement est
**à vol unique** : un appel, tous les autres l'attendent.

**La boucle infinie.** Le point de renouvellement répond lui-même 401, le
client tente de renouveler, qui répond 401… Les chemins qui ne doivent jamais
déclencher un renouvellement sont exclus par nom — `/auth/refresh` et
`/auth/login` en tête. Un mot de passe faux est un mot de passe faux, pas une
session expirée.

**Le rejeu de la mauvaise chose.** Une requête est rejouée **une fois** après
un renouvellement réussi. Un second 401 avec une session fraîche est une vraie
réponse — une permission refusée, pas un problème de jeton.

## Mise en place de la session

```js
const { createSessionClient, SessionExpiredError } = require('@astratra/client');

const session = createSessionClient({
  // Ton transport : axios, fetch, ce que tu veux. Doit rejeter avec un
  // `status` sur échec HTTP.
  request: (path, init) => api(path, init),

  // Ton renouvellement : poste le refresh token, met le stockage à jour.
  refresh: async () => {
    const { token } = await api('/auth/refresh', { method: 'POST' });
    await storage.setToken(token);
  },

  excluded: ['/auth/refresh', '/auth/login'],

  // Une seule fois par expiration définitive : vider le stockage, router
  // vers l'écran de connexion.
  onSessionExpired: () => router.replace('/login'),
});

const eleves = await session.call('/students');
```

Transport et stockage sont injectés : axios ou fetch, cookie ou SecureStore,
web ou mobile — **même logique**. C'est le point : cette mécanique existait en
deux exemplaires, une par plateforme, avec les mêmes pièges résolus deux fois.

L'expiration définitive surface en `SessionExpiredError` typée, avec la cause
d'origine conservée — l'interface peut router dessus sans analyser un message.

## Le garde de route

Le bug d'origine : la déconnexion remplaçait l'écran du dessus par la page de
connexion — toute la pile de navigation restait derrière. Quelques appuis sur
« retour » ramenaient sur le tableau de bord, déconnecté mais avec les données
encore à l'écran.

```js
const { createRouteGuard } = require('@astratra/client');

const guard = createRouteGuard({
  publicSegments: ['home', 'login', 'forgot-password', 'reset-password'],
});

// Dans ton layout de navigation :
if (guard.shouldRedirectToLogin({ isLoading, isAuthenticated, route: segments })) {
  router.replace(guard.loginRoute);
}
```

Deux décisions portent la protection :

**La liste nomme ce qui est PUBLIC, tout le reste est fermé.** Une liste
d'écrans protégés se lit plus naturellement et échoue en silence : chaque écran
ajouté ensuite et oublié dans la liste part ouvert en production.

**Tant que la session se restaure, rien n'est décidé.** Au démarrage,
« connecté » est faux avant d'être vrai ; rediriger sur cet état transitoire
éjecte un utilisateur parfaitement connecté à chaque démarrage à froid.

## Les règles de mot de passe

La forme habituelle : une expression régulière, recopiée dans l'écran
d'inscription et appliquée à l'aveugle par le serveur. L'utilisateur voit une
ligne — « 8 caractères min… » — et ne découvre qu'au rejet LAQUELLE des cinq
conditions manquait. Pire : les deux copies dérivent.

```js
const { createPasswordRules } = require('@astratra/client');

const rules = createPasswordRules();       // 8+, minuscule, majuscule, chiffre, spécial

rules.check('Abc1');
// [{ key: 'length', met: false }, { key: 'lowercase', met: true }, …]
// → l'écran coche les conditions pendant la frappe

rules.strength('Abc1');                    // 0.8 — la barre de progression
rules.canSubmit(password, confirmation);   // la condition du bouton
```

Chaque condition porte une **clé de traduction**, pas une phrase : la règle ne
transporte aucune langue. Et le module n'a aucune dépendance pour une raison
précise : **le même code tourne à l'écran et sur le serveur** — les deux bouts
ne peuvent plus se contredire.

---

# Hors ligne

Du travail qui survit à la perte du réseau.

Une application utilisée sur le terrain — une salle de classe sans signal, une
boutique au wifi capricieux — ne peut pas traiter « hors ligne » comme une
erreur. Une modification faite hors ligne est **enregistrée** au lieu
d'échouer : elle rejoint une file, et au retour du réseau la file se rejoue,
dans l'ordre.

Le stockage est injecté : IndexedDB sur le web, SQLite ou AsyncStorage sur
mobile, mémoire dans les tests. Même logique partout.

## Les règles qui rendent une file digne de confiance

**L'ordre est gardé.** « Marquer présent » puis « marquer absent » doivent
atterrir dans cet ordre, sinon le registre finit par dire le contraire de ce
que la personne a fait.

**Une panne arrête le rejeu, elle ne saute pas.** Sauter une action en échec et
appliquer celles de derrière rejoue l'histoire dans le désordre — précisément
ce que la file existe pour empêcher. La file s'arrête, rend compte, et reprend
au même endroit la prochaine fois.

**Sauf quand le serveur dit non.** Un refus (un 4xx) est une réponse : l'action
est fausse, et garder toute la file en otage derrière elle bloquerait pour
toujours tout ce qui suit. Les actions refusées sont mises de côté —
**visiblement** : l'utilisateur doit apprendre qu'un travail qu'il croit
sauvegardé ne l'est pas.

## Mise en place de la file

```js
const { createOfflineQueue } = require('@astratra/client');

const queue = createOfflineQueue({
  store: indexedDbStore,             // ou SQLite, ou AsyncStorage — createMemoryQueueStore() pour les tests
  handlers: {
    mark_attendance: (payload) => api.post('/attendance', payload),
    sign_assignment: (payload) => api.post('/assignments/sign', payload),
  },
  onRejected: (action, error) => toast.warn(`Refusé : ${error.message}`),
});

// Hors ligne : on enregistre au lieu d'échouer.
await queue.enqueue('mark_attendance', { student, state: 'present' });

// Au retour du réseau — événement de sync, focus, bouton manuel :
const { applied, rejected, halted, remaining } = await queue.replay();
```

Trois protections de plus, testées :

- **une action que personne ne sait rejouer est refusée à l'entrée**, pas
  échouée en silence dans la file pour toujours ;
- une action mise en file **sous une ancienne version de l'application** est
  écartée comme refusée, visiblement — attendre ne la rendra jamais rejouable ;
- **deux rejeux concurrents partagent une seule exécution** : un événement de
  sync plus un réessai manuel appliquent une fois, pas deux.

`pending()` donne ce qui attend — de quoi afficher un badge « 3 actions en
attente » dans l'interface.

---

## Ce que ce package ne fait pas

- Il ne stocke **aucun jeton** et ne parle pas HTTP : stockage et transport sont
  à toi.
- Il ne détecte pas la perte de réseau : brancher `replay()` sur tes événements
  (sync du service worker, `online`, focus) est ton choix.
- Il ne fournit pas de store IndexedDB ou SQLite : trois méthodes à écrire
  (`append`, `list`, `remove`), ton environnement les connaît mieux que lui.
- Il ne résout pas les conflits : un refus du serveur est remonté, la
  réconciliation est un choix produit.
- Il n'impose ni composants, ni hooks, ni framework.

## Tests

```bash
npm test --workspace @astratra/client
```
