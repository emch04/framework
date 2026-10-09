'use strict';
/*
 * Remote settings for the governor: a dashboard turns an agent on or off, pulls
 * or releases its kill switch, names its approvers and sets its reflection
 * schedule; humans approve or decline proposals there. This adapter turns
 * those settings into governor options and applies the human decisions through
 * the governor's own API. It imports Node built-ins and this folder only: the
 * settings come from a function you pass (`read`), never from a client package.
 *
 * Rules, all deterministic:
 *  - a silent source (error, timeout, invalid answer) keeps the last valid settings;
 *  - no valid settings ever seen: everything is off (disabled, halted, no approver);
 *  - a remote kill switch applies at once, even inside an otherwise invalid answer;
 *  - remote settings never touch the constitution, protected scopes, permissions,
 *    the approval matrix, nor budgets beyond the local ceilings.
 */
const { GovernorError, fingerprintOf, copy, isNonEmptyString } = require('./util');
const { validatePolicy } = require('./policy');
const { createGovernor } = require('./governor');

const SETTINGS_SCHEMA = 'conscience-settings/1';
const KNOWN_FIELDS = Object.freeze(['schema', 'version', 'enabled', 'halted', 'haltedAt', 'resumedBy', 'approvers', 'reflection', 'cyclesPerDay', 'updatedAt']);
const IDENTITY = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MAX_APPROVERS = 50;
const MAX_CYCLES = 1000;
const DEFAULT_ACTOR = Object.freeze({ kind: 'system', id: 'remote-settings' });
const RESULTS = Object.freeze(['applied', 'already_applied', 'refused', 'failed']);

const invalid = (field) => new GovernorError('invalid_settings', `Remote settings rejected: ${field}.`);

function validTimeZone(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch (_error) { return false; }
}

/**
 * Checks remote settings and returns their complete, frozen form. Unknown
 * fields are listed in `ignored`, never applied: a remote answer carrying a
 * constitution, budgets or permissions changes none of them.
 */
function parseRemoteSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('not an object');
  if (raw.schema !== undefined && raw.schema !== SETTINGS_SCHEMA) throw invalid('schema');
  const version = raw.version ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) throw invalid('version');
  for (const field of ['enabled', 'halted']) if (typeof raw[field] !== 'boolean') throw invalid(field);
  const approvers = raw.approvers ?? [];
  if (!Array.isArray(approvers) || approvers.length > MAX_APPROVERS || !approvers.every((id) => typeof id === 'string' && IDENTITY.test(id))) throw invalid('approvers');
  const reflection = raw.reflection ?? { automatic: false, hour: 4, timeZone: 'UTC' };
  if (!reflection || typeof reflection !== 'object' || typeof reflection.automatic !== 'boolean'
    || !Number.isInteger(reflection.hour) || reflection.hour < 0 || reflection.hour > 23 || !validTimeZone(reflection.timeZone ?? 'UTC')) throw invalid('reflection');
  const cycles = raw.cyclesPerDay ?? 0;
  if (!Number.isInteger(cycles) || cycles < 0 || cycles > MAX_CYCLES) throw invalid('cyclesPerDay');
  const resumedBy = raw.resumedBy ?? null;
  if (resumedBy !== null && (typeof resumedBy !== 'string' || !IDENTITY.test(resumedBy))) throw invalid('resumedBy');
  return Object.freeze({
    version, enabled: raw.enabled, halted: raw.halted, resumedBy: raw.halted ? null : resumedBy,
    approvers: Object.freeze([...new Set(approvers)]),
    reflection: Object.freeze({ automatic: reflection.automatic, hour: reflection.hour, timeZone: reflection.timeZone ?? 'UTC' }),
    cyclesPerDay: cycles,
    ignored: Object.freeze(Object.keys(raw).filter((key) => !KNOWN_FIELDS.includes(key)).sort())
  });
}

/**
 * The governor policy for these settings: the local policy, narrowed. Budgets
 * per agent and per organisation become `cyclesPerDay × costPerCycle`, never
 * above the local values; approvers are the remote ones (within the local list
 * when it exists); disabled, halted or unknown settings halt the governor.
 */
function remotePolicy(localPolicy, settings, { costPerCycle = 1 } = {}) {
  const local = validatePolicy(localPolicy);
  if (typeof costPerCycle !== 'number' || !Number.isFinite(costPerCycle) || costPerCycle < 0) throw new GovernorError('policy_invalid', 'costPerCycle must be a finite number >= 0.');
  const base = copy(localPolicy);
  if (!settings) return { ...base, version: `${local.version}.remote-none`, halted: true, approvers: [] };
  const cap = settings.cyclesPerDay * costPerCycle;
  const approvers = local.approvers ? settings.approvers.filter((id) => local.approvers.includes(id)) : [...settings.approvers];
  return {
    ...base,
    version: `${local.version}.remote-${settings.version}`,
    budgets: {
      perCycle: local.budgets.perCycle,
      perAgent: Math.min(local.budgets.perAgent, cap),
      perOrganisation: Math.min(local.budgets.perOrganisation, cap),
      periodMs: local.budgets.periodMs
    },
    approvers,
    halted: local.halted || settings.halted || !settings.enabled
  };
}

/* Governor options are equal when they hold the same values (the same store, the same clock…). */
function sameOptions(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** The hour (0 to 23) and the date (YYYY-MM-DD) of an instant in a time zone. */
function localTime(at, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return { hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

function createRemoteSettings(options = {}) {
  const { read, policy, organisationId, storage = null, costPerCycle = 1 } = options;
  if (typeof read !== 'function') throw new GovernorError('invalid_settings', 'read() is required: a function that returns the remote settings.');
  if (!isNonEmptyString(organisationId)) throw new GovernorError('organisation_required', 'Remote settings need the organisationId of this governor.');
  validatePolicy(policy);
  const now = options.now ?? Date.now;
  const actor = { kind: String(options.actor?.kind ?? DEFAULT_ACTOR.kind), id: String(options.actor?.id ?? DEFAULT_ACTOR.id) };
  if (actor.kind === 'human') throw new GovernorError('actor_not_allowed', 'The remote settings actor is a system, never a human.');

  let settings = null;
  let source = 'none';
  let lastError = null;
  let fetchedAt = null;
  let forcedHalt = false;
  let loaded = false;
  let cached = null;

  const emit = (event) => { try { options.onEvent?.({ type: 'remote_settings', ...event }); } catch (_error) { /* observers change nothing */ } };

  async function loadStored() {
    if (loaded || !storage || typeof storage.load !== 'function') { loaded = true; return; }
    loaded = true;
    try {
      const snapshot = await storage.load();
      if (snapshot && snapshot.settings) {
        settings = parseRemoteSettings(snapshot.settings);
        source = 'last_known';
        fetchedAt = typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : null;
      }
    } catch (_error) { /* a broken cache is the same as no cache */ }
  }

  async function save() {
    if (!storage || typeof storage.save !== 'function') return;
    try { await storage.save({ settings: { ...settings, schema: SETTINGS_SCHEMA }, fetchedAt }); } catch (_error) { /* the memory copy stays */ }
  }

  /** Reads the source once. Never throws: the outcome says which settings are in force and why. */
  async function refresh() {
    await loadStored();
    let raw;
    try {
      raw = await read();
    } catch (_error) {
      lastError = 'source_unavailable';
      if (settings) source = 'last_known';
      emit({ action: 'refresh', outcome: 'source_unavailable', source });
      return { source, changed: false, error: lastError };
    }
    /* A kill switch is honoured even inside an answer that fails validation or is stale. */
    const haltSignal = !!raw && typeof raw === 'object' && raw.halted === true;
    let parsed;
    try { parsed = parseRemoteSettings(raw); } catch (error) {
      lastError = error.code ?? 'invalid_settings';
      const changed = haltSignal && !forcedHalt;
      if (haltSignal) forcedHalt = true;
      if (settings) source = 'last_known';
      emit({ action: 'refresh', outcome: lastError, source, halted: haltSignal });
      return { source, changed, error: lastError };
    }
    if (settings && parsed.version < settings.version) {
      lastError = 'stale_settings';
      const changed = parsed.halted && !forcedHalt;
      if (parsed.halted) forcedHalt = true;
      source = 'last_known';
      emit({ action: 'refresh', outcome: lastError, source });
      return { source, changed, error: lastError };
    }
    const changed = !settings || fingerprintOf(settings) !== fingerprintOf(parsed) || forcedHalt;
    settings = parsed;
    forcedHalt = false;
    source = 'remote';
    lastError = null;
    fetchedAt = new Date(now()).toISOString();
    if (changed) await save();
    emit({ action: 'refresh', outcome: 'ok', source, version: parsed.version, changed });
    return { source, changed, error: null };
  }

  function current() {
    const halted = !settings || settings.halted || forcedHalt;
    return {
      source, known: !!settings, version: settings?.version ?? null, fetchedAt, error: lastError,
      enabled: !!settings && settings.enabled && !halted,
      halted,
      resumedBy: halted ? null : settings.resumedBy,
      approvers: settings ? [...settings.approvers] : [],
      reflection: settings ? { ...settings.reflection } : { automatic: false, hour: 4, timeZone: 'UTC' },
      cyclesPerDay: settings?.cyclesPerDay ?? 0,
      ignored: settings ? [...settings.ignored] : []
    };
  }

  function effectivePolicy() {
    const merged = remotePolicy(policy, settings, { costPerCycle });
    return forcedHalt ? { ...merged, halted: true } : merged;
  }

  /** The governor for the settings in force, rebuilt only when they change its policy. Ask for it each time you need it. */
  function governor(governorOptions = {}) {
    const next = effectivePolicy();
    const key = fingerprintOf(next);
    if (!cached || cached.key !== key || !sameOptions(cached.options, governorOptions)) {
      cached = { key, options: governorOptions, governor: createGovernor(next, { now, ...governorOptions }) };
    }
    return cached.governor;
  }

  /** The latest halt or resume of this organisation recorded by the governor. */
  async function lastSwitch(target) {
    const [entry] = await target.listAudit({ organisationId, actions: ['halt', 'resume'], limit: 1 });
    return entry ?? null;
  }

  /**
   * Applies the remote kill switch to the governor's store at once (candidates
   * go back to their stable version). A halt pulled here is released only by
   * the human named in `resumedBy`; a halt pulled by anyone else stays.
   */
  async function sync(target) {
    const state = current();
    const last = await lastSwitch(target);
    const haltedHere = last?.action === 'halt';
    if (state.halted) {
      if (haltedHere) return { action: 'none', halted: true };
      await target.halt({ by: actor, organisationId, reason: state.known ? 'remote_halt' : 'remote_unknown' });
      emit({ action: 'halt', organisationId });
      return { action: 'halt', halted: true };
    }
    if (!haltedHere) return { action: 'none', halted: false };
    if (last.actor?.id !== actor.id || last.actor?.kind !== actor.kind) return { action: 'none', halted: true, reason: 'halted_by_another_actor' };
    if (!state.resumedBy) return { action: 'none', halted: true, reason: 'resume_needs_human' };
    await target.resume({ by: { kind: 'human', id: state.resumedBy }, organisationId, reason: 'remote_resume' });
    emit({ action: 'resume', organisationId });
    return { action: 'resume', halted: false };
  }

  function decisionOf(input) {
    if (!input || typeof input !== 'object') return null;
    const { id, proposalId, decision, approver, reasonCode } = input;
    if (!isNonEmptyString(id) || !isNonEmptyString(proposalId) || !['approve', 'decline'].includes(decision)) return null;
    if (!approver || approver.kind !== 'human' || !isNonEmptyString(approver.id)) return null;
    if (decision === 'decline' && !isNonEmptyString(reasonCode)) return null;
    return { id, proposalId, decision, approver: { kind: 'human', id: approver.id }, reasonCode: reasonCode ?? null };
  }

  async function alreadyDone(target, d) {
    const proposal = await target.getProposal(organisationId, d.proposalId);
    if (!proposal) return false;
    if (d.decision === 'approve') return (proposal.approvals ?? []).some((a) => a.approver?.id === d.approver.id);
    return proposal.status === 'declined' && proposal.approver?.id === d.approver.id;
  }

  /**
   * Submits human decisions to the governor, one by one. Replays are safe: a
   * decision already recorded comes back as `already_applied`. The governor
   * keeps every check (approvers, halt, protected scopes, roles, expiry).
   * `failed` means the governor could not be reached: try again later.
   */
  async function applyDecisions(target, decisions) {
    const results = [];
    for (const input of Array.isArray(decisions) ? decisions : []) {
      const d = decisionOf(input);
      const ref = { id: input?.id ?? null, proposalId: input?.proposalId ?? null };
      if (!d) { results.push({ ...ref, result: 'refused', code: 'invalid_decision' }); continue; }
      if (!settings) { results.push({ ...ref, result: 'refused', code: 'settings_unknown' }); continue; }
      if (!settings.approvers.includes(d.approver.id)) { results.push({ ...ref, result: 'refused', code: 'approver_not_allowed' }); continue; }
      try {
        if (d.decision === 'approve') await target.approveProposal(d.proposalId, { approver: d.approver, organisationId });
        else await target.declineProposal(d.proposalId, { approver: d.approver, organisationId, reasonCode: d.reasonCode });
        results.push({ ...ref, result: 'applied', code: null });
      } catch (error) {
        if (!(error instanceof GovernorError)) { results.push({ ...ref, result: 'failed', code: 'governor_unavailable' }); continue; }
        let done = error.code === 'already_approved';
        if (!done && error.code === 'not_pending') {
          try { done = await alreadyDone(target, d); } catch (_error) { results.push({ ...ref, result: 'failed', code: 'governor_unavailable' }); continue; }
        }
        results.push({ ...ref, result: done ? 'already_applied' : 'refused', code: done ? null : String(error.code ?? 'refused') });
      }
    }
    emit({ action: 'decisions', count: results.length });
    return results;
  }

  /** True during the configured local hour, when the agent is on and not halted. */
  function reflectionDue(at = now()) {
    const state = current();
    if (!state.enabled || !state.reflection.automatic) return false;
    return localTime(at, state.reflection.timeZone).hour === state.reflection.hour;
  }

  /** A stable id for the reflection cycle of the local day: an idempotent spend, one cycle per day. */
  function reflectionCycleId(at = now()) {
    return `reflection_${localTime(at, current().reflection.timeZone).date}`;
  }

  return Object.freeze({ refresh, current, policy: effectivePolicy, governor, sync, applyDecisions, reflectionDue, reflectionCycleId });
}

module.exports = { createRemoteSettings, parseRemoteSettings, remotePolicy, REMOTE_SETTINGS_SCHEMA: SETTINGS_SCHEMA, DECISION_RESULTS: RESULTS };
