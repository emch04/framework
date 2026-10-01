import { buildEncounter, buildObservation, buildPatient, createReference, isReferenceTo, parseReference, validateResource, VITAL_SIGNS } from './src';
import type { Patient, ValidationResult } from './src';

const patient: Patient = buildPatient({ id: 'p1', family: 'Mukendi', given: ['Grace'], gender: 'female', birthDate: '1990-04-12', phone: '+243 81 234 5678' });
const subject = createReference(patient, 'Grace Mukendi');
const encounter = buildEncounter({ id: 'e1', status: 'in-progress', classCode: 'AMB', subject, start: '2026-10-01T09:00:00Z' });
const pressure = buildObservation({ vital: 'systolicBloodPressure', value: 120, subject, encounter: createReference(encounter) });
const verdict: ValidationResult = validateResource(pressure);
const parsed = parseReference('https://hote/fhir/Patient/p1/_history/2');
const sign: string = VITAL_SIGNS.heartRate.code;
void [verdict.valid, parsed?.id, isReferenceTo(subject, 'Patient'), sign];
