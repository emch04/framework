# @astratra/fhir

Bases pour la future app santé : les **types FHIR R4** officiels de
[`@medplum/fhirtypes`](https://github.com/medplum/medplum) (Apache-2.0, types
seulement, aucun code à l'exécution), plus quelques utilitaires : validation
minimale de `Patient`, `Encounter` et `Observation`, références, et
constructeurs avec de vrais codes LOINC et unités UCUM.

## Exemple

```js
const { buildPatient, buildEncounter, buildObservation, createReference, validateResource } = require('@astratra/fhir');

const patient = buildPatient({ id: 'p1', family: 'Mukendi', given: 'Grace', gender: 'female', birthDate: '1990-04-12', phone: '+243 81 234 5678' });
const subject = createReference(patient, 'Grace Mukendi');                   // { reference: 'Patient/p1', display }
const visite = buildEncounter({ id: 'e1', status: 'in-progress', classCode: 'AMB', subject, start: '2026-10-01T09:00:00Z' });
const pouls = buildObservation({ vital: 'heartRate', value: 72, subject, encounter: createReference(visite) });

validateResource(pouls); // { valid: true, issues: [] }
validateResource({ resourceType: 'Patient', birthDate: '2026-02-30', gender: 'homme' });
// { valid: false, issues: [{ severity: 'error', code: 'value', path: 'Patient.birthDate', message: … }, …] }
```

En TypeScript : `import type { Patient, Observation } from '@astratra/fhir'` (réexport
des types Medplum).

## Ce que la validation contrôle

Elle est **minimale** et volontairement lisible ; ce n'est pas un validateur FHIR
complet (pas de profils, ni de terminologie, ni de FHIRPath).

- **Patient** : `gender` (male/female/other/unknown), `birthDate` (année, mois ou
  jour **existant**), `name` non vide, `telecom` (valeur + système), `identifier`,
  `deceased[x]` exclusif et postérieur à la naissance, `active` booléen, `id`.
- **Encounter** : `status` et `class` (Coding, obligatoire en R4) ; `subject` vers
  Patient/Group ; `period` cohérente (fin ≥ début) ; dateTime **avec fuseau**.
- **Observation** : `status`, `code` (coding ou text), une seule `value[x]`, quantité
  numérique, `value` exclusive de `dataAbsentReason`, composantes (tension),
  `encounter` vers Encounter. Un code sans `system` donne un avertissement.
- `validateResource` refuse tout autre type (`not-supported`) au lieu de
  l'accepter en silence.

Chaque anomalie : `{ severity: 'error' | 'warning', code, path (FHIRPath), message }` ;
`valid` est faux dès qu'il y a une erreur.

## Références

`createReference(ressource, display?)`, `parseReference(ref)` (relative, absolue,
`_history`) et `isReferenceTo(ref, 'Patient')`. Les références internes (`#id`) et
les URN ne désignent pas de ressource adressable : `null`.

## Constantes vitales

`VITAL_SIGNS` : poids, taille, pouls, température, saturation, tension systolique
et diastolique — codes LOINC et unités UCUM. `buildObservation({ vital, value })`
renseigne la catégorie `vital-signs` et la quantité.

## Version

`@medplum/fhirtypes` déclare Node 22+ dans ses `engines` (simple avertissement
à l installation) ; rien de Medplum ne s exécute dans ce paquet.
