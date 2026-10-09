'use strict';
const { ConscienceError } = require('./errors');
const { isNonEmptyString, copy } = require('./governor/util');

const KINDS = Object.freeze(['decision', 'prediction', 'outcome', 'correction', 'lesson', 'self_model']);
const OUTCOME_STATUSES = Object.freeze(['succeeded', 'failed', 'unknown']);
const CORRECTION_CLASSES = Object.freeze(['factual', 'style', 'objective', 'disagreement']);
const LESSON_STATUSES = Object.freeze(['hypothesis', 'verified', 'to_reassess', 'retired']);
const EVIDENCE_DEGREES = Object.freeze(['none', 'anecdotal', 'observational', 'experimental', 'replicated']);
const EVIDENCE_KINDS = Object.freeze(['decision', 'prediction', 'outcome', 'correction', 'external']);
const PROVENANCE_KINDS = Object.freeze(['sensor', 'tool', 'human', 'feedback', 'system', 'model']);

const invalid = (message) => { throw new ConscienceError('invalid_input', message); };

function text(value, field, { required = true, max = 20000 } = {}) {
  if (value == null || value === '') { if (required) invalid(`${field} is required.`); return null; }
  if (typeof value !== 'string') invalid(`${field} must be a string.`);
  if (value.length > max) invalid(`${field} is longer than ${max} characters.`);
  return value;
}

function date(value, field, { required = true } = {}) {
  if (value == null) { if (required) invalid(`${field} is required (a date).`); return null; }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) invalid(`${field} must be a valid date.`);
  return parsed.toISOString();
}

function unit(value, field, { required = true } = {}) {
  if (value == null) { if (required) invalid(`${field} is required (a number between 0 and 1).`); return null; }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid(`${field} must be a number between 0 and 1.`);
  return value;
}

function strings(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) invalid(`${field} must be an array of strings.`);
  return [...value];
}

function oneOf(value, list, field) {
  if (!list.includes(value)) invalid(`${field} must be one of ${list.join(', ')}.`);
  return value;
}

function scopeOf(input) {
  if (!input || typeof input !== 'object') invalid('Input must be an object.');
  if (!isNonEmptyString(input.organisationId)) throw new ConscienceError('organisation_required', 'organisationId is required.');
  if (input.userId != null && !isNonEmptyString(input.userId)) invalid('userId must be a non-empty string.');
  return { organisationId: input.organisationId, userId: input.userId ?? null };
}

function provenanceOf(value, field) {
  if (!value || typeof value !== 'object') invalid(`${field} { kind, id } is required.`);
  return { kind: oneOf(value.kind, PROVENANCE_KINDS, `${field}.kind`), id: text(value.id, `${field}.id`, { max: 500 }) };
}

function decision(input) {
  const scope = scopeOf(input);
  const context = input.context;
  if (!context || typeof context !== 'object') invalid('context { at, summary?, data? } is required.');
  const action = input.action;
  if (!action || typeof action !== 'object') invalid('action { name, kind?, input? } is required.');
  const expected = input.expectedOutcome;
  if (!expected || typeof expected !== 'object') invalid('expectedOutcome { description, metric?, target? } is required.');
  const versions = input.versions;
  if (!versions || typeof versions !== 'object') invalid('versions { model?, tools?, instructions? } are required.');
  const alternatives = input.alternatives ?? [];
  if (!Array.isArray(alternatives)) invalid('alternatives must be an array.');
  const tools = input.tools ?? [];
  if (!Array.isArray(tools) || !tools.every((tool) => tool && isNonEmptyString(tool.name))) invalid('tools must be an array of { name, version?, callId? }.');
  const at = date(context.at, 'context.at');
  return {
    ...scope,
    agentId: text(input.agentId, 'agentId', { max: 200 }),
    objective: text(input.objective, 'objective'),
    context: { at, summary: text(context.summary, 'context.summary', { required: false }), data: copy(context.data) ?? null },
    action: { name: text(action.name, 'action.name', { max: 500 }), kind: action.kind ?? null, input: copy(action.input) ?? null },
    alternatives: alternatives.map((alt) => (typeof alt === 'string' ? { name: alt, reason: null } : { name: text(alt?.name, 'alternatives[].name', { max: 500 }), reason: alt.reason ?? null })),
    expectedOutcome: { description: text(expected.description, 'expectedOutcome.description'), metric: expected.metric ?? null, target: copy(expected.target) ?? null },
    horizon: date(input.horizon, 'horizon'),
    confidence: unit(input.confidence, 'confidence'),
    permissions: strings(input.permissions, 'permissions'),
    versions: { model: versions.model ?? null, tools: copy(versions.tools) ?? null, instructions: versions.instructions ?? null },
    inputSnapshotRef: text(input.inputSnapshotRef, 'inputSnapshotRef', { required: false, max: 2000 }),
    tools: tools.map((tool) => ({ name: tool.name, version: tool.version ?? null, callId: tool.callId ?? null })),
    decidedAt: date(input.decidedAt ?? at, 'decidedAt')
  };
}

function prediction(input) {
  return {
    ...scopeOf(input),
    decisionId: text(input.decisionId, 'decisionId', { max: 500 }),
    statement: text(input.statement, 'statement'),
    probability: unit(input.probability, 'probability'),
    resolvesBy: date(input.resolvesBy, 'resolvesBy'),
    madeAt: date(input.madeAt, 'madeAt', { required: false })
  };
}

function outcome(input) {
  const confounders = input.confounders ?? [];
  if (!Array.isArray(confounders) || !confounders.every((item) => typeof item === 'string')) invalid('confounders must be an array of strings.');
  return {
    ...scopeOf(input),
    decisionId: text(input.decisionId, 'decisionId', { max: 500 }),
    status: oneOf(input.status, OUTCOME_STATUSES, 'status'),
    observation: text(input.observation, 'observation', { required: false }),
    sensor: text(input.sensor, 'sensor', { max: 200 }),
    sources: strings(input.sources, 'sources'),
    uncertainty: unit(input.uncertainty, 'uncertainty', { required: false }),
    confounders: [...confounders],
    provenance: provenanceOf(input.provenance, 'provenance'),
    observedAt: date(input.observedAt, 'observedAt')
  };
}

function correction(input) {
  return {
    ...scopeOf(input),
    decisionId: text(input.decisionId, 'decisionId', { max: 500 }),
    proposed: text(input.proposed, 'proposed', { max: 100000 }),
    final: text(input.final, 'final', { max: 100000 }),
    class: oneOf(input.class, CORRECTION_CLASSES, 'class'),
    authorRole: text(input.authorRole, 'authorRole', { max: 200 }),
    correctedAt: date(input.correctedAt, 'correctedAt')
  };
}

function lesson(input) {
  const evidence = input.evidence ?? [];
  if (!Array.isArray(evidence)) invalid('evidence must be an array.');
  const status = input.status ?? 'hypothesis';
  oneOf(status, LESSON_STATUSES, 'status');
  const degree = input.evidenceDegree ?? (evidence.length ? 'anecdotal' : 'none');
  oneOf(degree, EVIDENCE_DEGREES, 'evidenceDegree');
  const ids = (value, field) => strings(value, field);
  return {
    ...scopeOf(input),
    lessonId: input.lessonId == null ? null : text(input.lessonId, 'lessonId', { max: 500 }),
    agentId: input.agentId == null ? null : text(input.agentId, 'agentId', { max: 200 }),
    summary: text(input.summary, 'summary'),
    evidence: evidence.map((item, index) => {
      if (!item || typeof item !== 'object') invalid(`evidence[${index}] must be { kind, ref, note? }.`);
      return { kind: oneOf(item.kind, EVIDENCE_KINDS, `evidence[${index}].kind`), ref: text(item.ref, `evidence[${index}].ref`, { max: 2000 }), note: text(item.note, `evidence[${index}].note`, { required: false }) };
    }),
    evidenceDegree: degree,
    status,
    validFrom: date(input.validFrom, 'validFrom', { required: false }),
    validUntil: date(input.validUntil, 'validUntil', { required: false }),
    contradictions: ids(input.contradictions, 'contradictions'),
    supersedes: ids(input.supersedes, 'supersedes'),
    consent: input.consent == null ? null : copy(input.consent),
    retention: input.retention == null ? null : copy(input.retention),
    scenarioRef: text(input.scenarioRef, 'scenarioRef', { required: false, max: 2000 })
  };
}

function selfModel(input) {
  const scope = scopeOf(input);
  const capabilities = input.capabilities ?? [];
  if (!Array.isArray(capabilities)) invalid('capabilities must be an array.');
  const tools = input.tools ?? [];
  if (!Array.isArray(tools) || !tools.every((tool) => tool && isNonEmptyString(tool.name))) invalid('tools must be an array of { name, version? }.');
  const metrics = input.metrics ?? {};
  if (typeof metrics !== 'object' || Array.isArray(metrics) || !Object.values(metrics).every((value) => typeof value === 'number' && Number.isFinite(value))) invalid('metrics must map names to finite numbers.');
  return {
    ...scope,
    agentId: text(input.agentId, 'agentId', { max: 200 }),
    capabilities: capabilities.map((capability, index) => {
      if (!capability || !isNonEmptyString(capability.name)) invalid(`capabilities[${index}].name is required.`);
      const evidence = strings(capability.evidence, `capabilities[${index}].evidence`);
      if (!evidence.length) {
        throw new ConscienceError('capability_without_evidence', `Capability "${capability.name}" has no test evidence: the self-model only records tested facts.`);
      }
      return { name: capability.name, evidence, score: unit(capability.score, `capabilities[${index}].score`, { required: false }), testedAt: date(capability.testedAt, `capabilities[${index}].testedAt`, { required: false }) };
    }),
    tools: tools.map((tool) => ({ name: tool.name, version: tool.version ?? null })),
    limits: strings(input.limits, 'limits'),
    permissions: strings(input.permissions, 'permissions'),
    domains: strings(input.domains, 'domains'),
    metrics: { ...metrics },
    provenance: provenanceOf(input.provenance, 'provenance'),
    at: date(input.at, 'at', { required: false })
  };
}

module.exports = {
  KINDS, OUTCOME_STATUSES, CORRECTION_CLASSES, LESSON_STATUSES, EVIDENCE_DEGREES, EVIDENCE_KINDS, PROVENANCE_KINDS,
  scopeOf, normalize: { decision, prediction, outcome, correction, lesson, self_model: selfModel }
};
