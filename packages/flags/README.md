# @astratra/flags

Interrupteurs de fonctionnalités et expériences évalués de façon déterministe,
sur serveur comme dans le navigateur. Le paquet n'a aucune dépendance à
l'exécution. Il fournit une interface de fournisseur inspirée d'OpenFeature,
sans SDK ni protocole propriétaire.

## Exemple : Oracle à 10 % des écoles d'un pays

```js
const { createFlagProvider, createMemorySource } = require('@astratra/flags');

const source = createMemorySource({ flags: {
  oracle: {
    type: 'boolean', default: false, value: true,
    target: { country: 'FR' }, rollout: 10, seed: 'oracle-oct-2026'
  }
} });
const flags = createFlagProvider({ source });
const result = await flags.resolveBoolean('oracle', false, {
  targetingKey: 'school-42', // identifiant stable de l'école
  attributes: { country: 'FR', role: 'teacher', plan: 'pro', organization: 'school-42', platform: 'web', appVersion: '2.4.0' }
});
if (result.value) { /* activer Oracle */ }
```

`rollout` est un pourcentage de 0 à 100. Le seau est dérivé du hachage FNV-1a
32 bits de la graine et de la clé de ciblage : les affectations sont stables et
une hausse du pourcentage n'exclut pas les utilisateurs déjà inclus. Le ciblage
accepte les attributs utilisateur, notamment `role`, `country`, `plan`,
`school`/`organization`, `appVersion` et `platform` (iOS, Android ou web).

## Ciblage avancé

Les formes historiques restent disponibles : chaque attribut est comparé par
égalité stricte, ou par appartenance stricte si sa valeur attendue est une liste.
Les expressions composées s’écrivent avec `all` (ET) et `any` (OU); elles
peuvent être imbriquées. Un prédicat `version` compare `attributes.appVersion`.
Un prédicat `number` compare l’attribut nommé; sa valeur doit déjà être un
nombre fini. Une valeur absente, textuelle, `NaN` ou infinie ne satisfait pas
la règle.

```json
{
  "flags": {
    "nouveauParcoursMobile": {
      "type": "boolean", "default": false, "value": true,
      "target": {
        "all": [
          { "country": ["FR", "BE"] },
          { "plan": "pro" },
          { "any": [
            { "all": [
              { "platform": "ios" },
              { "version": { ">=": "1.1.9" } }
            ] },
            { "number": { "attribute": "studentCount", "between": [1, 500] } }
          ] }
        ]
      }
    }
  }
}
```

Les opérateurs de version sont `>=`, `>`, `<=`, `<`, `==` et `between`
(bornes incluses). Le comparateur complète les composants manquants par zéro,
ordonne numériquement les composants (`1.10.0` après `1.9.0`) et place une
préversion avant la version finale (`1.2.0-beta.1` avant `1.2.0`). Il accepte
aussi les alias JSON `gte`, `gt`, `lte`, `lt` et `eq`. Les opérateurs numériques
sont `>`, `>=`, `<`, `<=` et `between` (bornes incluses); les alias `gt`,
`gte`, `lt` et `lte` sont également acceptés. Un objet opérateur peut contenir
plusieurs contraintes, qui doivent toutes être satisfaites.

## Types de valeurs et expériences

Les types pris en charge sont `boolean`, `string`, `number` et `json`. Une
expérience définit des variantes pondérées dont les poids totalisent au plus
100. Les variantes de drapeaux utilisant le même `namespace` partagent le même
hachage et sont donc mutuellement exclusives/alignées pour un même utilisateur.

```js
const source = createMemorySource({ flags: {
  accueil: { type: 'json', default: {}, variants: [
    { name: 'controle', value: { layout: 'classic' }, weight: 50 },
    { name: 'nouveau', value: { layout: 'cards' }, weight: 50 }
  ], namespace: 'accueil-2026' }
} });
const flags = createFlagProvider({ source, onExposure: (event) => analytics.track('exposure', event) });
const detail = await flags.resolveObject('accueil', {}, { targetingKey: 'user-123' });
// detail contient value, reason, flagKey et variant.
```

## Sources de règles

- `createMemorySource(rules)` : règles injectées en mémoire; `set(rules)` les remplace.
- `createFileSource(path)` : lit et valide un fichier JSON à chaque évaluation.
- `createUrlSource(url, options)` : récupère les règles immédiatement à la première lecture, puis permet le rafraîchissement périodique via `start()`; `stop()` arrête le minuteur. Une réponse invalide ou une erreur conserve la dernière configuration valide. `initial` peut fournir le cache initial.

Les résultats incluent une `reason` (`STATIC`, `SPLIT`, `DEFAULT`,
`TARGETING_MATCH`, `TARGETING_MISMATCH`, `FLAG_NOT_FOUND` ou `ERROR`) et,
pour une variante, son nom. Les erreurs du callback d'exposition ne bloquent
pas l'évaluation. Utilisez une clé de ciblage stable et non sensible; le hachage
ne constitue ni une protection cryptographique ni un contrôle d'accès.

## Tests

```bash
npm test --workspace @astratra/flags
```
