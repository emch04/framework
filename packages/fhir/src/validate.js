'use strict';

const { parseReference } = require('./references');

const ID = /^[A-Za-z0-9\-.]{1,64}$/;
// R4 `date` : année, année-mois ou date complète.
const DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
// R4 `dateTime` : date partielle ou complète avec heure et fuseau obligatoire.
const DATE_TIME = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00)))?)?)?$/;

const GENDERS = ['male', 'female', 'other', 'unknown'];
const CONTACT_SYSTEMS = ['phone', 'fax', 'email', 'pager', 'url', 'sms', 'other'];
const ENCOUNTER_STATUS = ['planned', 'arrived', 'triaged', 'in-progress', 'onleave', 'finished', 'cancelled', 'entered-in-error', 'unknown'];
const OBSERVATION_STATUS = ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'];
const VALUE_KEYS = ['valueQuantity', 'valueCodeableConcept', 'valueString', 'valueBoolean', 'valueInteger', 'valueRange', 'valueRatio', 'valueSampledData', 'valueTime', 'valueDateTime', 'valuePeriod'];

/** Collecte les anomalies avec leur chemin FHIRPath (`Patient.name[0]`). */
function collector(type) {
  const issues = [];
  const add = (severity, code, path, message) => issues.push({ severity, code, path: `${type}${path ? `.${path}` : ''}`, message });
  return {
    issues,
    error: (code, path, message) => add('error', code, path, message),
    warning: (code, path, message) => add('warning', code, path, message)
  };
}

function finish(c) {
  return { valid: !c.issues.some((i) => i.severity === 'error'), issues: c.issues };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkBase(c, resource, type) {
  if (!isObject(resource)) { c.error('invalid', '', 'La ressource doit être un objet'); return false; }
  if (resource.resourceType !== type) { c.error('invalid', 'resourceType', `resourceType attendu : ${type}`); return false; }
  if (resource.id !== undefined && !ID.test(resource.id)) c.error('value', 'id', 'id invalide (1 à 64 caractères : lettres, chiffres, - et .)');
  return true;
}

function checkEnum(c, value, allowed, path, required) {
  if (value === undefined || value === null) {
    if (required) c.error('required', path, `${path} est obligatoire`);
    return;
  }
  if (!allowed.includes(value)) c.error('code-invalid', path, `${path} : « ${value} » n'est pas dans ${allowed.join(', ')}`);
}

function checkDate(c, value, pattern, path) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !pattern.test(value)) { c.error('value', path, `${path} : format de date FHIR invalide`); return; }
  // 2026-02-30 passe l'expression mais n'existe pas.
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (d !== undefined) {
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) c.error('value', path, `${path} : jour inexistant`);
  }
}

function checkReference(c, ref, path, { required = false, types } = {}) {
  if (ref === undefined || ref === null) {
    if (required) c.error('required', path, `${path} est obligatoire`);
    return;
  }
  if (!isObject(ref) || (typeof ref.reference !== 'string' && !ref.identifier && !ref.display)) {
    c.error('value', path, `${path} : une référence porte reference, identifier ou display`);
    return;
  }
  if (typeof ref.reference === 'string') {
    const parsed = parseReference(ref);
    if (!parsed && !ref.reference.startsWith('#') && !ref.reference.startsWith('urn:')) c.error('value', `${path}.reference`, `${path}.reference : référence illisible « ${ref.reference} »`);
    if (parsed && types && !types.includes(parsed.resourceType)) c.error('value', `${path}.reference`, `${path} doit désigner ${types.join(' ou ')}, pas ${parsed.resourceType}`);
  }
}

function checkCodeableConcept(c, concept, path, required) {
  if (concept === undefined || concept === null) {
    if (required) c.error('required', path, `${path} est obligatoire`);
    return;
  }
  const codings = Array.isArray(concept?.coding) ? concept.coding : [];
  if (!isObject(concept) || (codings.length === 0 && !concept.text)) { c.error('required', path, `${path} : au moins un coding ou un text`); return; }
  codings.forEach((coding, i) => {
    if (!coding?.code && !coding?.display) c.error('required', `${path}.coding[${i}]`, 'coding sans code');
    if (coding?.code && !coding.system) c.warning('informational', `${path}.coding[${i}]`, 'code sans system : ambigu');
  });
}

function checkPeriod(c, period, path) {
  if (period === undefined) return;
  checkDate(c, period?.start, DATE_TIME, `${path}.start`);
  checkDate(c, period?.end, DATE_TIME, `${path}.end`);
  if (period?.start && period?.end && Date.parse(period.end) < Date.parse(period.start)) c.error('invariant', path, `${path} : la fin précède le début`);
}

function checkQuantity(c, quantity, path) {
  if (!isObject(quantity) || typeof quantity.value !== 'number' || !Number.isFinite(quantity.value)) { c.error('value', `${path}.value`, `${path}.value doit être un nombre`); return; }
  if (quantity.code && !quantity.system) c.warning('informational', path, `${path} : code d'unité sans system (UCUM : http://unitsofmeasure.org)`);
}

function validatePatient(resource) {
  const c = collector('Patient');
  if (!checkBase(c, resource, 'Patient')) return finish(c);
  checkEnum(c, resource.gender, GENDERS, 'gender');
  checkDate(c, resource.birthDate, DATE, 'birthDate');
  if (resource.active !== undefined && typeof resource.active !== 'boolean') c.error('value', 'active', 'active doit être un booléen');
  if (resource.deceasedBoolean !== undefined && resource.deceasedDateTime !== undefined) c.error('invariant', 'deceased[x]', 'deceasedBoolean et deceasedDateTime sont exclusifs');
  checkDate(c, resource.deceasedDateTime, DATE_TIME, 'deceasedDateTime');
  (resource.name ?? []).forEach((name, i) => {
    const given = Array.isArray(name?.given) && name.given.some((g) => typeof g === 'string' && g.trim());
    if (!name?.family && !given && !name?.text) c.error('required', `name[${i}]`, 'name : family, given ou text requis');
  });
  (resource.telecom ?? []).forEach((point, i) => {
    if (!point?.value) c.error('required', `telecom[${i}]`, 'telecom sans value');
    if (point?.system !== undefined) checkEnum(c, point.system, CONTACT_SYSTEMS, `telecom[${i}].system`);
    else if (point?.value) c.error('invariant', `telecom[${i}]`, 'telecom avec value exige system (cpt-2)');
  });
  (resource.identifier ?? []).forEach((identifier, i) => {
    if (!identifier?.value && !identifier?.system) c.error('required', `identifier[${i}]`, 'identifier sans value ni system');
  });
  const birth = resource.birthDate;
  if (birth && resource.deceasedDateTime && resource.deceasedDateTime.slice(0, birth.length) < birth) c.error('invariant', 'deceasedDateTime', 'décès antérieur à la naissance');
  return finish(c);
}

function validateEncounter(resource) {
  const c = collector('Encounter');
  if (!checkBase(c, resource, 'Encounter')) return finish(c);
  checkEnum(c, resource.status, ENCOUNTER_STATUS, 'status', true);
  // R4 : `class` est un Coding obligatoire (en R5 elle devient une liste de CodeableConcept).
  if (!isObject(resource.class) || (!resource.class.code && !resource.class.display)) c.error('required', 'class', 'class (Coding) est obligatoire en R4');
  checkReference(c, resource.subject, 'subject', { types: ['Patient', 'Group'] });
  if (resource.status === 'in-progress' && resource.period?.end) c.warning('business-rule', 'period.end', 'rencontre « in-progress » avec une fin');
  checkPeriod(c, resource.period, 'period');
  return finish(c);
}

function validateObservation(resource) {
  const c = collector('Observation');
  if (!checkBase(c, resource, 'Observation')) return finish(c);
  checkEnum(c, resource.status, OBSERVATION_STATUS, 'status', true);
  checkCodeableConcept(c, resource.code, 'code', true);
  checkReference(c, resource.subject, 'subject');
  checkReference(c, resource.encounter, 'encounter', { types: ['Encounter'] });
  checkDate(c, resource.effectiveDateTime, DATE_TIME, 'effectiveDateTime');
  const values = VALUE_KEYS.filter((key) => resource[key] !== undefined);
  if (values.length > 1) c.error('invariant', 'value[x]', `une seule valeur permise, trouvé : ${values.join(', ')}`);
  if (resource.valueQuantity !== undefined) checkQuantity(c, resource.valueQuantity, 'valueQuantity');
  if (values.length && resource.dataAbsentReason) c.error('invariant', 'dataAbsentReason', 'valeur et dataAbsentReason sont exclusives (obs-6)');
  (resource.component ?? []).forEach((component, i) => {
    checkCodeableConcept(c, component?.code, `component[${i}].code`, true);
    if (component?.valueQuantity !== undefined) checkQuantity(c, component.valueQuantity, `component[${i}].valueQuantity`);
  });
  return finish(c);
}

const VALIDATORS = { Patient: validatePatient, Encounter: validateEncounter, Observation: validateObservation };

/** Choisit le validateur selon resourceType ; un type non géré est refusé, jamais accepté en silence. */
function validateResource(resource) {
  const validator = VALIDATORS[resource?.resourceType];
  if (validator) return validator(resource);
  return { valid: false, issues: [{ severity: 'error', code: 'not-supported', path: 'resourceType', message: `Type non géré : ${resource?.resourceType ?? '(absent)'} (Patient, Encounter, Observation)` }] };
}

module.exports = { validatePatient, validateEncounter, validateObservation, validateResource };
