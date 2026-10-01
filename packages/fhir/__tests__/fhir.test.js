'use strict';

const {
  validatePatient, validateEncounter, validateObservation, validateResource,
  createReference, parseReference, isReferenceTo, buildPatient, buildEncounter, buildObservation, quantity, VITAL_SIGNS
} = require('../src');

const codes = (result) => result.issues.map((i) => `${i.severity}:${i.code}:${i.path}`);

describe('références', () => {
  test('crée et relit une référence', () => {
    expect(createReference({ resourceType: 'Patient', id: 'abc-1' }, 'Grace')).toEqual({ reference: 'Patient/abc-1', display: 'Grace' });
    expect(parseReference('Patient/abc-1')).toEqual({ resourceType: 'Patient', id: 'abc-1', versionId: null, absolute: false });
    expect(parseReference({ reference: 'https://h/fhir/Encounter/e9/_history/3' })).toEqual({ resourceType: 'Encounter', id: 'e9', versionId: '3', absolute: true });
    expect(isReferenceTo('Patient/1', 'Patient')).toBe(true);
    expect(isReferenceTo('Patient/1', 'Encounter')).toBe(false);
  });
  test('références non adressables ou invalides', () => {
    for (const bad of ['#contained', 'urn:uuid:123', '', 'Patient', 'patient/1', null, undefined, {}]) expect(parseReference(bad)).toBeNull();
    expect(() => createReference({ resourceType: 'Patient' })).toThrow('RESOURCE_ID_REQUIRED');
    expect(() => createReference({ id: '1' })).toThrow('RESOURCE_TYPE_REQUIRED');
  });
});

describe('Patient', () => {
  test('un patient construit est valide', () => {
    const p = buildPatient({ id: 'p1', family: 'Mukendi', given: 'Grace', gender: 'female', birthDate: '1990-04-12', phone: '+243 81 234 5678', email: 'g@example.test', identifier: { system: 'urn:scolaris', value: '42' } });
    expect(validatePatient(p)).toEqual({ valid: true, issues: [] });
  });
  test('dates partielles acceptées, jour inexistant et format refusés', () => {
    expect(validatePatient({ resourceType: 'Patient', birthDate: '1990' }).valid).toBe(true);
    expect(validatePatient({ resourceType: 'Patient', birthDate: '1990-04' }).valid).toBe(true);
    expect(codes(validatePatient({ resourceType: 'Patient', birthDate: '2026-02-30' }))).toEqual(['error:value:Patient.birthDate']);
    expect(validatePatient({ resourceType: 'Patient', birthDate: '12/04/1990' }).valid).toBe(false);
  });
  test('genre, nom vide, télécom sans système, identifiant vide, décès incohérent', () => {
    const result = validatePatient({
      resourceType: 'Patient', id: 'mauvais id', gender: 'homme', name: [{}], telecom: [{ value: '1' }, { system: 'telepathie', value: '2' }, { system: 'phone' }], identifier: [{}],
      deceasedBoolean: true, deceasedDateTime: '2000-01-01T00:00:00Z', birthDate: '2010-01-01'
    });
    expect(codes(result)).toEqual(expect.arrayContaining([
      'error:value:Patient.id', 'error:code-invalid:Patient.gender', 'error:required:Patient.name[0]',
      'error:invariant:Patient.telecom[0]', 'error:code-invalid:Patient.telecom[1].system', 'error:required:Patient.telecom[2]',
      'error:required:Patient.identifier[0]', 'error:invariant:Patient.deceased[x]', 'error:invariant:Patient.deceasedDateTime'
    ]));
  });
  test('mauvais type ou non-objet', () => {
    expect(validatePatient({ resourceType: 'Encounter' }).valid).toBe(false);
    expect(validatePatient('x').valid).toBe(false);
    expect(validatePatient(null).valid).toBe(false);
  });
});

describe('Encounter', () => {
  const patient = createReference({ resourceType: 'Patient', id: 'p1' });
  test('valide, avec période cohérente', () => {
    const e = buildEncounter({ id: 'e1', status: 'finished', subject: patient, start: '2026-10-01T09:00:00Z', end: '2026-10-01T09:30:00Z' });
    expect(validateEncounter(e)).toEqual({ valid: true, issues: [] });
  });
  test('statut et classe obligatoires, période inversée, sujet du mauvais type', () => {
    const result = validateEncounter({ resourceType: 'Encounter', status: 'fini', subject: { reference: 'Practitioner/9' }, period: { start: '2026-10-02T09:00:00Z', end: '2026-10-01T09:00:00Z' } });
    expect(codes(result)).toEqual(expect.arrayContaining(['error:code-invalid:Encounter.status', 'error:required:Encounter.class', 'error:value:Encounter.subject.reference', 'error:invariant:Encounter.period']));
    expect(codes(validateEncounter({ resourceType: 'Encounter' }))).toEqual(expect.arrayContaining(['error:required:Encounter.status']));
  });
  test('avertissement : « in-progress » avec une fin', () => {
    const result = validateEncounter(buildEncounter({ status: 'in-progress', start: '2026-10-01T09:00:00Z', end: '2026-10-01T10:00:00Z' }));
    expect(result.valid).toBe(true);
    expect(result.issues[0]).toMatchObject({ severity: 'warning' });
  });
  test('dateTime sans fuseau refusé', () => {
    expect(validateEncounter(buildEncounter({ start: '2026-10-01T09:00:00' })).valid).toBe(false);
  });
});

describe('Observation', () => {
  test('une constante vitale construite est valide, avec LOINC et UCUM', () => {
    const o = buildObservation({ vital: 'heartRate', value: 72, subject: { reference: 'Patient/p1' }, effective: '2026-10-01T09:05:00+01:00' });
    expect(o.code.coding[0]).toMatchObject({ system: 'http://loinc.org', code: '8867-4' });
    expect(o.valueQuantity).toEqual({ value: 72, unit: 'beats/minute', system: 'http://unitsofmeasure.org', code: '/min' });
    expect(o.category[0].coding[0].code).toBe('vital-signs');
    expect(validateObservation(o)).toEqual({ valid: true, issues: [] });
  });
  test('statut et code obligatoires', () => {
    expect(codes(validateObservation({ resourceType: 'Observation' }))).toEqual(expect.arrayContaining(['error:required:Observation.status', 'error:required:Observation.code']));
    expect(codes(validateObservation({ resourceType: 'Observation', status: 'final', code: {} }))).toContain('error:required:Observation.code');
  });
  test('une seule valeur[x], quantité numérique, valeur xor dataAbsentReason', () => {
    const base = { resourceType: 'Observation', status: 'final', code: { text: 'poids' } };
    expect(codes(validateObservation({ ...base, valueString: 'a', valueBoolean: true }))).toContain('error:invariant:Observation.value[x]');
    expect(codes(validateObservation({ ...base, valueQuantity: { value: '72' } }))).toContain('error:value:Observation.valueQuantity.value');
    expect(codes(validateObservation({ ...base, valueString: 'a', dataAbsentReason: { text: 'x' } }))).toContain('error:invariant:Observation.dataAbsentReason');
  });
  test('code sans système : avertissement seulement ; composantes contrôlées', () => {
    const r = validateObservation({ resourceType: 'Observation', status: 'final', code: { coding: [{ code: '1' }] }, component: [{}, { code: { text: 'x' }, valueQuantity: {} }] });
    expect(r.issues.find((i) => i.code === 'informational')).toMatchObject({ severity: 'warning' });
    expect(codes(r)).toEqual(expect.arrayContaining(['error:required:Observation.component[0].code', 'error:value:Observation.component[1].valueQuantity.value']));
  });
  test('tension artérielle en composantes valide', () => {
    const bp = {
      resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
      component: [
        { code: { coding: [{ system: 'http://loinc.org', code: VITAL_SIGNS.systolicBloodPressure.code }] }, valueQuantity: quantity(120, 'mmHg', 'mm[Hg]') },
        { code: { coding: [{ system: 'http://loinc.org', code: VITAL_SIGNS.diastolicBloodPressure.code }] }, valueQuantity: quantity(80, 'mmHg', 'mm[Hg]') }
      ]
    };
    expect(validateObservation(bp)).toEqual({ valid: true, issues: [] });
  });
  test('constructeurs : constante inconnue, code manquant, valeur non numérique', () => {
    expect(() => buildObservation({ vital: 'vitesse' })).toThrow('UNKNOWN_VITAL_SIGN');
    expect(() => buildObservation({})).toThrow('CODE_REQUIRED');
    expect(() => quantity('1', 'kg')).toThrow('QUANTITY_VALUE_REQUIRED');
  });
});

describe('validateResource', () => {
  test('aiguille selon le type, refuse le reste', () => {
    expect(validateResource(buildPatient({ id: 'p' })).valid).toBe(true);
    expect(validateResource({ resourceType: 'Medication' })).toMatchObject({ valid: false, issues: [{ code: 'not-supported' }] });
    expect(validateResource(null).valid).toBe(false);
  });
});
