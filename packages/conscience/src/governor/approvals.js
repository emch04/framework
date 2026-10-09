'use strict';
/*
 * Approval matrix of the governor (proposition 20): which roles may approve
 * which kind of change, when a second approval is needed, how long an approval
 * stays valid, and the register of rejection reasons. Pure functions of the
 * policy and the proposal: no model, no clock of its own.
 */
const { GovernorError, isNonEmptyString } = require('./util');

const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
const DEFAULT_EXPIRY_MS = 7 * 24 * 3600 * 1000;
const CODE = /^[a-z][a-z0-9_]{1,40}$/;

/* Register of the reasons a person gives when declining a proposal. A policy can add codes, never remove one. */
const DECLINE_REASONS = Object.freeze([
  'insufficient_evidence', 'risk_too_high', 'not_needed', 'wrong_scope', 'poor_tests',
  'no_rollback_plan', 'conflicts_with_policy', 'bad_timing', 'duplicate', 'other'
]);

const rank = (level) => RISK_LEVELS.indexOf(level);
const fail = (message) => { throw new GovernorError('policy_invalid', `Invalid governor policy: ${message}`); };

function validateApprovals(input, modifiable) {
  const source = input ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) fail('approvals must be an object.');
  const stringList = (value, label) => {
    if (!Array.isArray(value) || !value.length || !value.every(isNonEmptyString)) fail(`${label} must be a non-empty array of strings.`);
    return [...new Set(value)];
  };

  let roles = null;
  if (source.roles != null) {
    if (typeof source.roles !== 'object' || Array.isArray(source.roles)) fail('approvals.roles must map a human identity to its roles.');
    roles = {};
    for (const [id, list] of Object.entries(source.roles)) roles[id] = stringList(list, `approvals.roles.${id}`);
  }

  const matrix = {};
  for (const [key, entry] of Object.entries(source.matrix ?? {})) {
    if (key !== 'default' && !modifiable.includes(key)) fail(`approvals.matrix.${key}: use a modifiable kind (${modifiable.join(', ')}) or "default".`);
    if (!entry || typeof entry !== 'object') fail(`approvals.matrix.${key} must be an object.`);
    const approvals = entry.approvals ?? 1;
    if (!Number.isInteger(approvals) || approvals < 1 || approvals > 5) fail(`approvals.matrix.${key}.approvals must be an integer from 1 to 5.`);
    matrix[key] = { roles: entry.roles == null ? null : stringList(entry.roles, `approvals.matrix.${key}.roles`), approvals };
  }
  if (Object.values(matrix).some((entry) => entry.roles) && !roles) fail('approvals.matrix lists roles, so approvals.roles must say who holds them.');

  const floors = {};
  for (const kind of modifiable) floors[kind] = 'medium';
  for (const [kind, level] of Object.entries(source.floors ?? {})) {
    if (!modifiable.includes(kind)) fail(`approvals.floors.${kind} is not a modifiable kind.`);
    if (rank(level) < 0) fail(`approvals.floors.${kind} must be one of ${RISK_LEVELS.join(', ')}.`);
    floors[kind] = level;
  }
  const doubleApprovalFrom = source.doubleApprovalFrom ?? 'high';
  if (rank(doubleApprovalFrom) < 0) fail(`approvals.doubleApprovalFrom must be one of ${RISK_LEVELS.join(', ')}.`);
  if (source.distinctRoles !== undefined && typeof source.distinctRoles !== 'boolean') fail('approvals.distinctRoles must be a boolean.');
  const expiresInMs = source.expiresInMs ?? DEFAULT_EXPIRY_MS;
  if (!Number.isInteger(expiresInMs) || expiresInMs <= 0) fail('approvals.expiresInMs must be a positive integer (milliseconds).');
  const extra = source.declineReasons ?? [];
  if (!Array.isArray(extra) || !extra.every((code) => typeof code === 'string' && CODE.test(code))) fail('approvals.declineReasons must be codes like "too_costly".');
  return {
    roles, matrix, floors, doubleApprovalFrom, distinctRoles: source.distinctRoles === true, expiresInMs,
    declineReasons: [...new Set([...DECLINE_REASONS, ...extra])]
  };
}

/**
 * What a proposal needs before it counts as approved. The risk is the higher of
 * the floor of its kind (set by the policy) and the level the proposer
 * declared: a proposer can raise the bar, never lower it.
 */
function assess(rules, proposal) {
  const kind = proposal.target?.kind;
  const a = rules.approvals;
  const floor = a.floors[kind] ?? 'medium';
  const asked = Object.hasOwn(proposal, 'declaredRisk') ? proposal.declaredRisk : proposal.risk;
  const declared = RISK_LEVELS.includes(asked) ? asked : null;
  const risk = declared && rank(declared) > rank(floor) ? declared : floor;
  const entry = a.matrix[kind] ?? a.matrix.default ?? null;
  const double = rank(risk) >= rank(a.doubleApprovalFrom);
  return {
    risk,
    requiredApprovals: Math.max(entry?.approvals ?? 1, double ? 2 : 1),
    allowedRoles: entry?.roles ?? null,
    distinctRoles: a.distinctRoles && double
  };
}

/** The role an approver acts under, or a GovernorError when the matrix does not allow them. */
function actingRole(rules, assessment, who, requestedRole) {
  const held = rules.approvals.roles?.[who.id] ?? [];
  if (requestedRole != null && !held.includes(requestedRole)) throw new GovernorError('approver_role_missing', 'This person does not hold the role they ask to act under.');
  if (!assessment.allowedRoles) return requestedRole ?? held[0] ?? null;
  const usable = held.filter((role) => assessment.allowedRoles.includes(role));
  const role = requestedRole ?? usable[0];
  if (!role || !assessment.allowedRoles.includes(role)) {
    throw new GovernorError('approver_role_missing', `This change needs one of the roles: ${assessment.allowedRoles.join(', ')}.`);
  }
  return role;
}

/** Approvals still valid at `atMs`. */
const liveApprovals = (proposal, atMs) => (Array.isArray(proposal.approvals) ? proposal.approvals : []).filter((a) => Date.parse(a.expiresAt) > atMs);

/**
 * Checks, from the stored record alone, that a proposal really holds the
 * approvals the current policy demands: humans only, distinct people, allowed
 * roles, enough of them, none expired. Returns { ok, code, reason }.
 */
function checkApprovals(rules, proposal, atMs) {
  const assessment = assess(rules, proposal);
  const all = Array.isArray(proposal.approvals) ? proposal.approvals : [];
  const live = liveApprovals(proposal, atMs);
  const bad = (code, reason) => ({ ok: false, code, reason, assessment });
  if (all.some((a) => a.approver?.kind !== 'human' || !isNonEmptyString(a.approver?.id))) return bad('approver_not_human', 'An approval does not come from a human identity.');
  if (!all.length) return bad('approval_invalid', 'The proposal holds no recorded approval.');
  if (live.length < assessment.requiredApprovals) {
    return live.length < all.length ? bad('approval_expired', 'An approval has expired: ask for a new decision.') : bad('approval_insufficient', 'The approvals are not enough for this risk.');
  }
  if (new Set(live.map((a) => a.approver.id)).size < live.length) return bad('approval_invalid', 'The same person approved twice.');
  if (live.some((a) => a.approver.id === proposal.proposedBy?.id && proposal.proposedBy?.kind === 'human')) return bad('self_approval', 'A person approved their own proposal.');
  if (rules.approvers && live.some((a) => !rules.approvers.includes(a.approver.id))) return bad('approver_not_allowed', 'An approver is not in the policy list.');
  if (assessment.allowedRoles) {
    const held = (a) => rules.approvals.roles?.[a.approver.id] ?? [];
    if (live.some((a) => !a.role || !held(a).includes(a.role) || !assessment.allowedRoles.includes(a.role))) return bad('approver_role_missing', 'An approval was given without an allowed role.');
  }
  if (assessment.distinctRoles && new Set(live.map((a) => a.role)).size < Math.min(2, assessment.requiredApprovals)) return bad('approval_roles_not_distinct', 'A high-risk change needs two different roles.');
  return { ok: true, assessment };
}

module.exports = { RISK_LEVELS, DECLINE_REASONS, DEFAULT_EXPIRY_MS, validateApprovals, assess, actingRole, liveApprovals, checkApprovals, rank };
