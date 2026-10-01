'use strict';

const UCUM = 'http://unitsofmeasure.org';
const LOINC = 'http://loinc.org';
const OBSERVATION_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';

/** Constantes vitales courantes : codes LOINC et unités UCUM réels. */
const VITAL_SIGNS = Object.freeze({
  bodyWeight: { code: '29463-7', display: 'Body weight', unit: 'kg', ucum: 'kg' },
  bodyHeight: { code: '8302-2', display: 'Body height', unit: 'cm', ucum: 'cm' },
  heartRate: { code: '8867-4', display: 'Heart rate', unit: 'beats/minute', ucum: '/min' },
  bodyTemperature: { code: '8310-5', display: 'Body temperature', unit: 'degC', ucum: 'Cel' },
  oxygenSaturation: { code: '59408-5', display: 'Oxygen saturation in Arterial blood by Pulse oximetry', unit: '%', ucum: '%' },
  systolicBloodPressure: { code: '8480-6', display: 'Systolic blood pressure', unit: 'mmHg', ucum: 'mm[Hg]' },
  diastolicBloodPressure: { code: '8462-4', display: 'Diastolic blood pressure', unit: 'mmHg', ucum: 'mm[Hg]' }
});

function quantity(value, unit, code) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('QUANTITY_VALUE_REQUIRED');
  return { value, unit, system: UCUM, code: code ?? unit };
}

function buildPatient({ id, family, given = [], gender, birthDate, phone, email, identifier, active = true } = {}) {
  return {
    resourceType: 'Patient',
    ...(id ? { id } : {}),
    active,
    ...(identifier ? { identifier: [identifier] } : {}),
    ...(family || given.length ? { name: [{ use: 'official', ...(family ? { family } : {}), ...(given.length ? { given: [].concat(given) } : {}) }] } : {}),
    ...((phone || email) ? { telecom: [...(phone ? [{ system: 'phone', value: phone }] : []), ...(email ? [{ system: 'email', value: email }] : [])] } : {}),
    ...(gender ? { gender } : {}),
    ...(birthDate ? { birthDate } : {})
  };
}

function buildEncounter({ id, status = 'planned', classCode = 'AMB', subject, start, end } = {}) {
  const classDisplay = { AMB: 'ambulatory', IMP: 'inpatient encounter', EMER: 'emergency', VR: 'virtual' }[classCode];
  return {
    resourceType: 'Encounter',
    ...(id ? { id } : {}),
    status,
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActMode', code: classCode, ...(classDisplay ? { display: classDisplay } : {}) },
    ...(subject ? { subject } : {}),
    ...((start || end) ? { period: { ...(start ? { start } : {}), ...(end ? { end } : {}) } } : {})
  };
}

/** `vital` : une clé de VITAL_SIGNS (ex. 'heartRate') ; sinon fournir `code` (CodeableConcept). */
function buildObservation({ id, status = 'final', vital, code, value, subject, encounter, effective } = {}) {
  const sign = vital ? VITAL_SIGNS[vital] : null;
  if (vital && !sign) throw new RangeError('UNKNOWN_VITAL_SIGN');
  if (!sign && !code) throw new TypeError('CODE_REQUIRED');
  return {
    resourceType: 'Observation',
    ...(id ? { id } : {}),
    status,
    ...(sign ? { category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: 'vital-signs', display: 'Vital Signs' }] }] } : {}),
    code: sign ? { coding: [{ system: LOINC, code: sign.code, display: sign.display }] } : code,
    ...(subject ? { subject } : {}),
    ...(encounter ? { encounter } : {}),
    ...(effective ? { effectiveDateTime: effective } : {}),
    ...(value !== undefined ? { valueQuantity: sign ? quantity(value, sign.unit, sign.ucum) : value } : {})
  };
}

module.exports = { VITAL_SIGNS, quantity, buildPatient, buildEncounter, buildObservation };
