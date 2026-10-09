'use strict';
const { GovernorError, deepFreeze, isNonEmptyString, copy } = require('./util');

/** What reflection may never change, whatever the justification. */
const PROTECTED_SCOPES = Object.freeze(['permissions', 'budgets', 'security', 'privacy', 'constitution', 'approvals', 'isolation', 'governor']);

/** The only objects a proposal may target, unless the policy narrows the list. */
const MODIFIABLE_KINDS = Object.freeze(['instructions', 'threshold', 'tool_description', 'routing']);

/** Change modes. Only "none" exists in this version: every proposal waits for a human. */
const AUTOMATIC_CHANGES = Object.freeze(['none']);

/*
 * Words that reveal a protected scope when they appear as a target kind, a
 * declared scope or a key of the change. Keys are compared lower case with
 * non-alphanumerics removed, so "organisationId" and "organisation_id" match.
 */
const SCOPE_WORDS = Object.freeze({
  permissions: ['permission', 'permissions', 'role', 'roles', 'grant', 'grants', 'acl'],
  budgets: ['budget', 'budgets', 'spend', 'spending', 'costcap', 'maxcost', 'quota', 'quotas'],
  security: ['security', 'guard', 'guards', 'safety', 'sandbox'],
  privacy: ['privacy', 'retention', 'erasure', 'consent', 'masking', 'masker', 'redaction'],
  constitution: ['constitution', 'constitutionrule', 'constitutionrules'],
  approvals: ['approval', 'approvals', 'approver', 'approvers', 'automaticchanges', 'autoapprove'],
  isolation: ['isolation', 'organisation', 'organisationid', 'organization', 'organizationid', 'tenant', 'tenantid'],
  governor: ['governor', 'policy', 'killswitch', 'halt', 'halted']
});

const DEFAULT_CONSTITUTION = Object.freeze(PROTECTED_SCOPES.map((scope) => Object.freeze({
  id: `protect-${scope}`,
  description: `Reflection may not change ${scope}.`,
  protectedScope: scope,
  owner: 'governor'
})));

const fail = (message) => { throw new GovernorError('policy_invalid', `Invalid governor policy: ${message}`); };
const normalWord = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

function validRule(rule, index) {
  if (!rule || typeof rule !== 'object') fail(`constitution[${index}] must be an object.`);
  for (const field of ['id', 'description', 'protectedScope', 'owner']) {
    if (!isNonEmptyString(rule[field])) fail(`constitution[${index}].${field} must be a non-empty string.`);
  }
  return { id: rule.id, description: rule.description, protectedScope: rule.protectedScope.trim().toLowerCase(), owner: rule.owner };
}

function validBudget(budgets, field) {
  const value = budgets[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`budgets.${field} must be a finite number >= 0.`);
  return value;
}

/**
 * Checks a policy and returns its frozen, complete form. The default
 * constitution is always included: a policy can add rules, never remove one.
 */
function validatePolicy(policy) {
  if (policy == null) throw new GovernorError('policy_missing', 'No governor policy: reflection cannot start without one.');
  if (typeof policy !== 'object' || Array.isArray(policy)) fail('must be an object.');
  const version = policy.version ?? '1';
  if (!isNonEmptyString(version)) fail('version must be a non-empty string.');

  if (!policy.budgets || typeof policy.budgets !== 'object') fail('budgets { perCycle, perAgent, perOrganisation } are required.');
  const budgets = {
    perCycle: validBudget(policy.budgets, 'perCycle'),
    perAgent: validBudget(policy.budgets, 'perAgent'),
    perOrganisation: validBudget(policy.budgets, 'perOrganisation'),
    periodMs: policy.budgets.periodMs ?? 86400000
  };
  if (!Number.isInteger(budgets.periodMs) || budgets.periodMs <= 0) fail('budgets.periodMs must be a positive integer.');

  const extra = policy.constitution ?? [];
  if (!Array.isArray(extra)) fail('constitution must be an array.');
  const constitution = [...DEFAULT_CONSTITUTION.map(copy), ...extra.map(validRule)];
  const ids = new Set();
  for (const rule of constitution) { if (ids.has(rule.id)) fail(`constitution rule "${rule.id}" is declared twice.`); ids.add(rule.id); }

  const modifiable = policy.permissions?.modifiable ?? [...MODIFIABLE_KINDS];
  if (!Array.isArray(modifiable) || !modifiable.every(isNonEmptyString)) fail('permissions.modifiable must be an array of strings.');
  for (const kind of modifiable) {
    if (!MODIFIABLE_KINDS.includes(kind)) fail(`permissions.modifiable may only list ${MODIFIABLE_KINDS.join(', ')}; "${kind}" is not modifiable by a proposal.`);
  }

  const automaticChanges = policy.automaticChanges ?? 'none';
  if (!AUTOMATIC_CHANGES.includes(automaticChanges)) fail('automaticChanges must be "none": every proposal waits for human approval.');
  const isolation = policy.isolation ?? 'organisation';
  if (isolation !== 'organisation') fail('isolation must be "organisation".');

  const approvers = policy.approvers ?? null;
  if (approvers !== null && (!Array.isArray(approvers) || !approvers.every(isNonEmptyString))) fail('approvers must be an array of human identities.');

  if (policy.halted !== undefined && typeof policy.halted !== 'boolean') fail('halted must be a boolean.');

  return deepFreeze({
    version, budgets, constitution, permissions: { modifiable: [...new Set(modifiable)] },
    automaticChanges, isolation, approvers: approvers && [...new Set(approvers)], halted: policy.halted === true
  });
}

/** Every scope a proposal touches: target kind and id, declared scopes, keys of the change. */
function scopesOf(proposal) {
  const out = new Set();
  const add = (value) => { if (value != null && String(value).trim()) out.add(String(value).trim().toLowerCase()); };
  const target = proposal.target || {};
  add(target.kind);
  if (target.kind != null && target.id != null) add(`${target.kind}:${target.id}`);
  add(target.id);
  for (const scope of Array.isArray(proposal.scopes) ? proposal.scopes : []) add(scope);
  const keys = (value, depth) => {
    if (depth > 32 || !value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { add(key); keys(child, depth + 1); }
  };
  keys(proposal.change, 0);
  return out;
}

/** Constitution rules a proposal would touch. Deterministic: names and keys, never free text. */
function protectedRulesTouched(policy, proposal) {
  const scopes = scopesOf(proposal);
  const words = new Set([...scopes].map(normalWord));
  const touched = [];
  for (const rule of policy.constitution) {
    const scope = rule.protectedScope;
    let hit;
    if (scope.endsWith('*')) hit = [...scopes].some((value) => value.startsWith(scope.slice(0, -1)));
    else hit = scopes.has(scope) || words.has(normalWord(scope));
    if (!hit && SCOPE_WORDS[scope]) hit = SCOPE_WORDS[scope].some((word) => words.has(word));
    if (hit) touched.push(rule.id);
  }
  return touched;
}

module.exports = { PROTECTED_SCOPES, MODIFIABLE_KINDS, AUTOMATIC_CHANGES, DEFAULT_CONSTITUTION, SCOPE_WORDS, validatePolicy, scopesOf, protectedRulesTouched };
