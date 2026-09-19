# @astratra/entitlements

Les plans, les fonctionnalités qu'ils débloquent, qui a le droit de voir quel
écran, et ce que la plateforme prélève. Les quatre questions que tout produit
vendu par abonnement finit par se poser, et qu'on finit par répondre à quatre
endroits différents — jusqu'à ce que deux des réponses divergent.

Aucune dépendance à l'exécution. Aucun plan, aucun rôle, aucun taux imposé :
`starter`/`pro`/`enterprise` est le vocabulaire d'un produit, `solo`/`équipe`
en est un autre.

# Plans et droits

## La liste des invitations, côté écran

Le côté serveur est plus haut : il fabrique les liens, les range en empreinte
et ne les accepte qu'une fois. Celui-ci lit ce qui revient — et une règle
justifie à elle seule le module.

```js
const board = createInvitationBoard({ invitable: { owner: ['seller'] } });

board.readMany(payload);
board.effectiveStatus(invitation);   // recalculé, jamais cru sur parole
board.initialTab(invitations);       // s'ouvre sur ce qui demande une action
```

**Une invitation en attente dont la date est passée est expirée, quoi qu'en
dise le serveur.** Celui-ci ne bascule le statut qu'au moment où quelqu'un
ouvre le lien ; jusque-là la ligne dit « en attente ». L'afficher telle quelle
promet un lien qui fonctionne alors qu'il est déjà mort : la personne l'envoie,
le destinataire reçoit une erreur, et l'expéditeur doit deviner pourquoi.

**« Terminées » réunit les expirées, les révoquées et les échouées** : dans les
trois cas la seule suite possible est d'en refaire une.

**Un statut inconnu se lit « en attente »** — la ligne reste à l'écran et
actionnable, plutôt que de disparaître dans un onglet que personne n'ouvre.

## Le catalogue

```js
const { createPlanCatalog } = require('@astratra/entitlements');

const catalog = createPlanCatalog({
  plans: {
    essai:      ['tableau_de_bord', 'rapports', 'analytique'],
    demarrage:  ['tableau_de_bord', 'rapports'],
    pro:        ['tableau_de_bord', 'rapports', 'analytique'],
  },
  labels: { essai: 'Essai gratuit', demarrage: 'Démarrage', pro: 'Pro' },
  upgradePath: { demarrage: 'pro' },
  // Le plan de repli quand un compte porte un plan que le catalogue ne connaît
  // plus — une offre renommée, une migration à moitié faite.
  fallbackPlan: 'demarrage',
});

catalog.hasFeature('demarrage', 'analytique');              // false
catalog.hasFeature('demarrage', 'analytique', ['analytique']); // true
```

Deux détails qui comptent plus qu'il n'y paraît.

**Un plan inconnu retombe sur le plus petit**, pas sur le plus généreux. Un plan
mal orthographié doit donner le moins d'accès possible, pas le plus.

**`overrides` existe parce que les vrais clients existent.** Un compte a négocié
une fonctionnalité hors de son offre ; l'écrire en dur dans le plan la
donnerait à tout le monde.

## Le garde

```js
const { createFeatureGuard } = require('@astratra/entitlements');

const guard = createFeatureGuard({
  catalog,
  // Où vit le plan du compte : à toi de le dire. Renvoyer null veut dire
  // « rien à facturer ici » et laisse passer.
  resolveAccount: async (req) => {
    const compte = await Comptes.findById(req.user.organisation);
    return compte ? { plan: compte.plan, overrides: compte.extras } : null;
  },
  isExempt: (req) => ['support', 'fondateur'].includes(req.user.role),
  // Interrupteur global, vérifié AVANT le plan.
  isEnabled: async (feature) => !(await Maintenance.estCoupee(feature)),
});

app.get('/api/analytique', guard('analytique'), controleur);
```

L'ordre n'est pas un détail : **l'interrupteur de maintenance passe avant le
plan**. Une fonctionnalité coupée l'est aussi pour l'offre qui la paie — lui
répondre « passez à l'offre supérieure » serait un mensonge.

### En cas de panne, la porte se ferme

`onError` vaut `'deny'` par défaut. Une base injoignable ne doit pas ouvrir
toutes les fonctionnalités payantes : un garde qui s'ouvre en tombant est un
garde qu'il suffit de casser, pas de vaincre.

Un produit peut légitimement préférer rester debout plutôt que fermé —
`onError: 'allow'` est là pour ça. Mais que ce soit un choix, pas un oubli.

## Le blocage d'un compte entier

Une suspension n'est pas une question d'offre. Un compte impayé ou gelé perd
tout d'un coup, et lui parler de montée en gamme serait déplacé.

```js
const { createStatusGuard } = require('@astratra/entitlements');

app.use(createStatusGuard({
  resolveStatus: async (req) => {
    const compte = await Comptes.findById(req.user.organisation);
    return compte ? { status: compte.statut, name: compte.nom, reason: compte.motif } : null;
  },
  blockedStatuses: ['suspendu', 'ferme'],
  isExempt: (req) => req.user.role === 'support',
}));
```

## La commission

```js
const { createCommissionSchedule } = require('@astratra/entitlements');

const bareme = createCommissionSchedule({
  defaultRate: 0.01,
  rates: { entreprise: 0.005, interne: 0 },
});

bareme.commissionOn(10_000, 'entreprise');  // { rate: 0.005, commission: 50, net: 9950 }
```

Les montants sont en **unités mineures entières** — centimes, cents. Laisser une
fraction de centime dans un virement est la façon la plus sûre de faire cesser
un grand livre d'être équilibré. `commission + net` égale toujours le montant,
et un test le vérifie sur toute une série de valeurs.

## Qui voit quel écran

Différent des fonctionnalités, et la différence compte : une fonctionnalité est
ce que le compte **paie**, un écran est ce qu'une personne a le **droit** de
voir. La page finances peut être incluse dans l'offre et ne regarder aucun
enseignant.

```js
const { createAccessMatrix, except } = require('@astratra/entitlements');

const TOUS = ['proprietaire', 'admin', 'enseignant', 'secretaire', 'parent', 'eleve'];

const acces = createAccessMatrix({
  screens: {
    tableau_de_bord: TOUS,
    finances:        ['proprietaire', 'admin', 'secretaire'],
    notes:           except(TOUS, 'parent', 'eleve'),
  },
  superRoles: ['support'],
});

acces.canAccess('finances', 'enseignant');  // false
acces.screensFor('parent');                 // ['tableau_de_bord'] — de quoi bâtir un menu
```

**Un écran absent de la table est fermé**, jamais ouvert. L'inverse est la façon
dont un écran part en production visible par tout le monde parce que personne
n'a pensé à l'ajouter.

`except()` existe parce que ces tables s'écrivent toujours « tout le monde
sauf… », et qu'énumérer le reste à la main est la façon d'oublier un rôle sur
une ligne.

## L'isolation par locataire

Chaque requête multi-locataires doit porter le filtre du locataire, et
l'oublier une seule fois montre à une école les élèves d'une autre. Le scope
centralise la décision — et surtout, décide de ce qui arrive quand le locataire
**manque**.

```js
const { createTenantScope } = require('@astratra/entitlements');

const scope = createTenantScope({
  field: 'school',
  globalRoles: ['hero_admin', 'support'],
  // Pour un store qui compare strictement les types :
  impossibleValue: new ObjectId('000000000000000000000000'),
  onMissingTenant: (user) => logger.error('utilisateur sans établissement', user.id),
});

const eleves = await Student.find(scope.scope(req.user, { status: 'active' }));
```

**Pas de locataire = aucune ligne, jamais toutes les lignes.** Un compte à
moitié migré, un jeton émis avant un changement de schéma : cet utilisateur
reçoit un filtre qui ne peut rien trouver, pas une requête sans borne qui
renvoie les données de tout le monde. On échoue fermé — et `onMissingTenant`
sonne l'alarme, parce qu'un utilisateur sans locataire mérite mieux qu'un écran
vide silencieux.

---

# Invitations

Inviter quelqu'un à rejoindre — par lien, une fois, pour un temps. C'est le
premier acte du cycle de vie des droits : le lien porte déjà le rôle.

## Les trois propriétés qui rendent le parcours sûr

**Le jeton est stocké en empreinte.** La base détient sa signature SHA-256,
jamais le jeton lui-même — une collection qui fuite ne doit pas permettre
d'accepter toutes les invitations en attente. Le jeton complet existe
exactement deux fois : dans le lien, et à l'instant de la vérification.

**L'acceptation est à usage unique, atomiquement.** La revendication est une
transition de statut atomique dans le store : deux personnes qui ouvrent le
même lien à la même seconde créent un compte, pas deux.

**Une nouvelle invitation retire les anciennes.** Inviter deux fois la même
adresse ne doit pas laisser deux liens vivants — le plus vieux est exactement
le genre de chose qui ressort d'une boîte mail des mois plus tard.

## Mise en place

```js
const { createInvitations } = require('@astratra/entitlements');

const invitations = createInvitations({
  store,
  roles: ['teacher', 'secretary', 'director'],

  // Tourne À L'INTÉRIEUR de l'acceptation : un échec marque l'invitation
  // "failed", jamais "used".
  createAccount: async (invitation, form) =>
    Users.create({ email: invitation.email, role: invitation.role, ...form }),

  buildUrl: (token) => `${APP_URL}/register?token=${token}`,
  deliver: ({ invitation, url }) => mailer.send({ to: invitation.email, /* … */ }),
});

// Inviter — le jeton est rendu ICI et plus jamais.
const { token, url } = await invitations.invite({
  email: 'marie@ecole.cd', role: 'teacher', invitedBy: directorId,
});

// La page d'inscription pré-remplit :
const { email, role } = await invitations.verify(token);

// Accepter :
const { account } = await invitations.accept(token, { name, password });
```

## Les décisions encodées, chacune testée

**Le rôle vient de l'invitation, jamais du formulaire.** Un formulaire qui
enverrait `role: 'director'` est ignoré : c'est l'inviteur qui a décidé.

**Un échec de création marque `failed`, jamais `used`.** « Utilisée » pour un
compte qui n'est jamais né bloque la personne : lien mort, aucun compte.

**Inconnue et déjà utilisée répondent le même message.** Savoir lequel des deux
est une information qu'un attaquant qui sonde des jetons n'a pas à obtenir.

**Un envoi raté ne détruit pas l'invitation.** Le lien reste copiable depuis
l'interface et s'envoie à la main.

**Une invitation sans e-mail existe** — un lien affiché à l'écran, un QR code
en salle des professeurs.

**Une révocation consigne qui a fermé le lien**, et une invitation déjà
tranchée répond 409 plutôt que de se laisser révoquer en silence.

## Le store des invitations

Cinq méthodes, dont une atomique :

```
create(data)                      findByTokenHash(hash)
claim(id, from[], patch)          — la transition atomique
update(id, patch)                 retirePending(email)   list(filter)
```

`createMemoryInvitationStore()` est fourni pour les tests et le développement.

# Un rôle, un seul titulaire

Le compte au sommet — fondateur, propriétaire de la plateforme — détient les
clés de service et l'accès de dernier recours. Un second compte de ce rang
double ce pouvoir en silence, et deux titulaires peuvent se révoquer l'un
l'autre. La règle est simple ; la tenir ne l'est pas, parce qu'un rôle arrive
par plusieurs portes : la création, la promotion, le changement d'identifiant,
et l'écriture directe en base qui ne traverse aucun code.

`createUniqueRole` garde les trois premières portes, et sa sentinelle
(`sweep`) rattrape la quatrième. Chaque tentative refusée déclenche une alerte.

```js
const { createUniqueRole } = require('@astratra/entitlements');

const owner = createUniqueRole({
  role: 'owner',                              // le nom du rôle, à toi
  anchor: () => process.env.OWNER_EMAIL,      // l'identifiant du titulaire légitime
  store: {
    findHolders: (role) => Users.find({ role: new RegExp(`^\\s*${role}\\s*$`, 'i') }).lean(),
    remove: async (account, role) =>
      (await Users.deleteOne({ _id: account._id, role })).deletedCount === 1
  },
  alert: async (event) => mailer.send(ownerAddress, t(`alerts.${event.kind}`, event)),
  messages: { role_taken: t('errors.role_taken'), holder_protected: t('errors.holder_protected') }
});

// sur chaque chemin d'écriture
await owner.assertCanCreate({ role: body.role, actor: req.user });
await owner.assertCanChangeRole({ account: stored, nextRole: body.role, actor: req.user });
await owner.assertCanRename({ account: stored, nextIdentifier: body.email, actor: req.user });
await owner.assertCanModify({ target: stored, actor: req.user });

// toutes les heures, sous un verrou partagé entre instances
await owner.sweep();
```

## Les décisions encodées, chacune testée

| Tentative | Réponse | Alerte |
|---|---|---|
| Créer un titulaire alors qu'un autre existe | `409 role_taken` | `create_refused` |
| Promouvoir un compte alors qu'un autre titulaire existe | `409 role_taken` | `promotion_refused` |
| Rétrograder le titulaire | `409 last_holder` | `demotion_refused` |
| Prendre l'identifiant du titulaire (quelqu'un d'autre) | `409 identity_taken` | `rename_refused` |
| Modifier ou supprimer le compte du titulaire (quelqu'un d'autre) | `403 holder_protected` | `modify_refused` |
| Créer le premier titulaire, plateforme vide | autorisé (`allowBootstrap: false` pour l'interdire, `403`) | — |
| Le titulaire enregistre son propre compte | autorisé | — |

- **La casse et les espaces ne contournent rien** : ` OWNER ` est le rôle.
- **Le store fait foi, pas l'objet passé** : un compte qui arrive avec le rôle
  déjà appliqué (le document vu par un hook d'ORM) est quand même comparé aux
  titulaires en base, exclu par son identifiant seulement.
- **Aucun texte en dur** : sans `messages[reason]`, le message est le code.
  L'alerte reçoit un événement structuré ; destinataire et formulation sont à toi.
- **L'alerte ne décide jamais** : si elle échoue, le refus tient quand même, et
  la sentinelle efface quand même.

## La sentinelle

Elle efface des comptes : elle est écrite pour ne jamais effacer le bon. En
cas de doute, elle ne fait RIEN.

| Situation en base | Effacement | Alerte |
|---|---|---|
| Un titulaire, l'ancré | aucun | — |
| Plusieurs titulaires, l'ancré parmi eux | tous sauf l'ancré | `intruders_removed` |
| Plusieurs titulaires, pas d'ancre configurée | aucun | `anchor_missing` |
| Plusieurs titulaires, aucun ne porte l'ancre | aucun | `anchor_not_found` |
| Un seul titulaire, qui n'est PAS l'ancré | aucun | `anchor_mismatch` — c'est à ça que ressemble un titulaire remplacé |

`sweep({ dryRun: true })` dit ce qu'elle ferait sans rien effacer ni envoyer.
`store.remove` doit n'effacer que si le compte porte TOUJOURS le rôle : un
compte rétrogradé entre la lecture et l'écriture n'est pas supprimé par erreur.

## Ce que ce module ne fait pas

- **Il ne ferme pas la course à l'amorçage.** Deux créations simultanées sur une
  plateforme vide passent toutes deux la vérification ; seul un index unique
  partiel en base (`{ role: 1 }` unique où `role = 'owner'`) l'empêche.
- Il ne planifie rien : horaire et verrou entre instances sont à toi.
- Il ne masque pas le titulaire dans les listes ni les exports.
- Il ne voit pas les écritures en masse (`updateMany`, `insertMany`,
  `bulkWrite`) si tu ne l'appelles pas pour chaque compte concerné.

# Ce que ce package ne fait pas

- Il ne sait pas **où** vit le plan d'un compte : tu le lui donnes.
- Il ne décide pas **qui** est exempté de facturation.
- Il n'impose ni plans, ni rôles, ni taux, ni devise.
- Il ne crée pas les comptes invités : `createAccount` est à toi, avec ton
  hachage de mot de passe et tes modèles.
- Il n'envoie rien : `deliver` se branche sur `@astratra/notify` ou autre.
- Il ne stocke rien et n'appelle aucune base.

## Tests

```bash
npm test --workspace @astratra/entitlements
```
