'use strict';
const crypto = require('node:crypto');
const { GovernorError, fingerprintOf, copy, isNonEmptyString } = require('./util');
const { createMemoryGovernorStore } = require('./stores');
const { createCalendarBudget, isAmount } = require('./calendar');

/*
 * Tool policy: decides, by code and outside any model, whether ONE call of a tool
 * may run. Generic on purpose: families, levels, caps and every word of the
 * vocabulary come from configuration; nothing here knows what a tool does.
 *
 * Order of examination of a call:
 *   emergency stop > agent disabled > unknown tool > family disabled > invalid input
 *   > calendar budget > caps > level (sensitive, untrusted context, over threshold).
 * Whatever cannot be read (settings, kill switch, budget) refuses: it never lets a call through.
 */

const TOOL_LEVELS = Object.freeze({ READ: 'read', CONTROLLED: 'controlled', SENSITIVE: 'sensitive' });
const TOOL_DECISIONS = Object.freeze({ ALLOWED: 'allowed', PENDING: 'pending', REFUSED: 'refused' });
const TOOL_REASONS = Object.freeze({
  HALTED: 'emergency_stop',
  DISABLED: 'disabled',
  UNAVAILABLE: 'settings_unavailable',
  UNKNOWN_TOOL: 'unknown_tool',
  FAMILY_DISABLED: 'family_disabled',
  INVALID_INPUT: 'invalid_input',
  BUDGET: 'budget_exceeded',
  CAP: 'cap_reached',
  SENSITIVE: 'sensitive_tool',
  UNTRUSTED: 'untrusted_context',
  THRESHOLD: 'over_threshold'
});

const LEVELS = Object.values(TOOL_LEVELS);
const DECISIONS = Object.values(TOOL_DECISIONS);
const CODES = Object.values(TOOL_REASONS);
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;
const GLOBAL = '*';
const NEVER_RELEASE = Object.freeze(['model', 'engine']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => { throw new GovernorError('tool_policy_invalid', `Invalid tool policy: ${message}`); };
const stringList = (value, field) => {
  if (!Array.isArray(value) || !value.length || !value.every(isNonEmptyString)) fail(`${field} must be a non-empty array of strings.`);
  return [...new Set(value)];
};

/** Vocabulary: canonical word -> your word. Only the words you list are renamed. */
function vocabulary(labels = {}, canonical, field) {
  if (!isObject(labels)) fail(`labels.${field} must be an object.`);
  const toApp = {}; const toCanonical = {};
  for (const word of canonical) {
    const mine = labels[word] ?? word;
    if (!isNonEmptyString(mine)) fail(`labels.${field}.${word} must be a non-empty string.`);
    toApp[word] = mine;
    if (toCanonical[mine] !== undefined) fail(`labels.${field} gives the same word to two entries ("${mine}").`);
    toCanonical[mine] = word;
  }
  for (const word of Object.keys(labels)) if (!canonical.includes(word)) fail(`labels.${field}.${word} is not one of: ${canonical.join(', ')}.`);
  return { toApp, toCanonical };
}

function normalizeSettings(raw) {
  if (!isObject(raw)) throw new GovernorError('settings_invalid', 'Tool settings must be an object.');
  const out = {};
  if (raw.enabled !== undefined) { if (typeof raw.enabled !== 'boolean') throw new GovernorError('settings_invalid', 'enabled must be a boolean.'); out.enabled = raw.enabled; }
  if (raw.families !== undefined) {
    if (!isObject(raw.families) || !Object.values(raw.families).every((value) => typeof value === 'boolean')) throw new GovernorError('settings_invalid', 'families must map a family to a boolean.');
    out.families = { ...raw.families };
  }
  if (raw.budgetLimit !== undefined && raw.budgetLimit !== null) { if (!isAmount(raw.budgetLimit)) throw new GovernorError('settings_invalid', 'budgetLimit must be an integer >= 0.'); out.budgetLimit = raw.budgetLimit; }
  if (raw.maxCallsPerRun !== undefined && raw.maxCallsPerRun !== null) {
    if (!Number.isSafeInteger(raw.maxCallsPerRun) || raw.maxCallsPerRun < 1) throw new GovernorError('settings_invalid', 'maxCallsPerRun must be an integer >= 1.');
    out.maxCallsPerRun = raw.maxCallsPerRun;
  }
  for (const [key, value] of Object.entries(raw)) if (!['enabled', 'families', 'budgetLimit', 'maxCallsPerRun'].includes(key)) out[key] = copy(value);
  return out;
}

function normalizeTool(definition, levelOf, families) {
  if (!isObject(definition)) fail('a tool must be an object.');
  if (!TOOL_NAME.test(definition.name ?? '')) fail(`invalid tool name: ${definition.name}.`);
  const name = definition.name;
  if (!isNonEmptyString(definition.family)) fail(`${name}: family is required.`);
  if (families && !families.includes(definition.family)) fail(`${name}: family "${definition.family}" is not in families.`);
  const level = levelOf.toCanonical[definition.level];
  if (!level) fail(`${name}: level must be one of ${Object.keys(levelOf.toCanonical).join(', ')}.`);
  for (const field of ['validate', 'overThreshold']) if (definition[field] !== undefined && typeof definition[field] !== 'function') fail(`${name}: ${field} must be a function.`);
  if (definition.maxPerRun !== undefined && (!Number.isSafeInteger(definition.maxPerRun) || definition.maxPerRun < 1)) fail(`${name}: maxPerRun must be an integer >= 1.`);
  if (definition.estimatedCost !== undefined && !isAmount(definition.estimatedCost)) fail(`${name}: estimatedCost must be an integer >= 0.`);
  return Object.freeze({
    name, family: definition.family, level, validate: definition.validate ?? null, overThreshold: definition.overThreshold ?? null,
    maxPerRun: definition.maxPerRun ?? null, estimatedCost: definition.estimatedCost ?? 0, budgetExempt: definition.budgetExempt === true
  });
}

const actorOf = (actor) => (isObject(actor)
  ? { kind: String(actor.kind ?? ''), id: String(actor.id ?? ''), roles: Array.isArray(actor.roles) ? actor.roles.map(String) : [] }
  : null);
const hasRole = (actor, roles) => actor.roles.some((role) => roles.includes(role));

/**
 * Builds the tool policy.
 * options: tools, families?, defaults?, settings?, budget?, emergency?, labels?, untrustedPendingLevels?,
 *          store?, governor?, version?, pollMs?, now?, idFactory?, onEvent?
 */
function createToolPolicy(options = {}) {
  if (!isObject(options)) fail('options must be an object.');
  const labels = options.labels ?? {};
  const levelWords = vocabulary(labels.levels, LEVELS, 'levels');
  const decisionWords = vocabulary(labels.decisions, DECISIONS, 'decisions');
  const codeWords = vocabulary(labels.codes, CODES, 'codes');
  const families = options.families === undefined ? null : stringList(options.families, 'families');
  if (!Array.isArray(options.tools) || !options.tools.length) fail('tools must list at least one tool.');
  const tools = new Map();
  for (const definition of options.tools) {
    const tool = normalizeTool(definition, levelWords, families);
    if (tools.has(tool.name)) fail(`tool declared twice: ${tool.name}.`);
    tools.set(tool.name, tool);
  }
  const untrustedLevels = (options.untrustedPendingLevels ?? [levelWords.toApp.controlled]).map((word) => {
    const level = levelWords.toCanonical[word];
    if (!level) fail(`untrustedPendingLevels: unknown level ${word}.`);
    return level;
  });
  const emergency = options.emergency ?? {};
  const activateRoles = emergency.activateRoles === undefined ? null : stringList(emergency.activateRoles, 'emergency.activateRoles');
  const releaseRoles = emergency.releaseRoles === undefined ? null : stringList(emergency.releaseRoles, 'emergency.releaseRoles');

  const store = options.store ?? createMemoryGovernorStore();
  for (const method of ['appendAudit', 'getControl', 'setControl']) {
    if (typeof store[method] !== 'function') throw new GovernorError('governor_unavailable', `Tool policy store is missing ${method}().`);
  }
  const now = options.now ?? Date.now;
  const newId = options.idFactory ?? (() => crypto.randomUUID());
  const version = options.version ?? '1';
  const pollMs = options.pollMs ?? 1000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 0) fail('pollMs must be an integer >= 0 (0 turns the polling off).');
  const readSettings = options.settings ?? null;
  if (readSettings !== null && typeof readSettings !== 'function') fail('settings must be a function.');
  const defaults = normalizeSettings(options.defaults ?? {});
  const budget = options.budget == null ? null : (typeof options.budget.check === 'function' ? options.budget : createCalendarBudget({ now, ...options.budget }));
  if (budget && typeof budget.record !== 'function') fail('budget must have check() and record().');
  const governor = options.governor ?? null;
  if (governor && typeof governor.isHalted !== 'function') fail('governor must be built by createGovernor().');

  const active = new Set();
  const iso = () => new Date(now()).toISOString();

  async function audit(entry) {
    const full = { id: newId(), at: iso(), policyVersion: version, organisationId: null, proposalId: null, reasons: [], actor: null, ...entry };
    await store.appendAudit(full);
    try { await options.onEvent?.({ type: 'tool_policy', ...copy(full) }); } catch (_error) { /* Observers never change a decision. */ }
    return full;
  }

  async function haltState(organisationId) {
    const global = await store.getControl(`tools-halt:${GLOBAL}`);
    if (global?.halted) return { halted: true, scope: GLOBAL, reason: global.reason ?? null };
    if (organisationId != null) {
      const local = await store.getControl(`tools-halt:${organisationId}`);
      if (local?.halted) return { halted: true, scope: organisationId, reason: local.reason ?? null };
    }
    if (governor && await governor.isHalted(organisationId ?? undefined)) return { halted: true, scope: 'governor', reason: 'governor_halted' };
    return { halted: false };
  }

  async function currentSettings(call) {
    const raw = readSettings ? await readSettings({ organisationId: call.organisationId ?? null, actor: actorOf(call.actor) }) : {};
    const settings = normalizeSettings(raw ?? {});
    return { ...defaults, ...settings, families: { ...defaults.families, ...settings.families } };
  }

  function createRun() {
    const run = { calls: 0, byTool: {}, untrusted: false, markUntrusted() { run.untrusted = true; } };
    return run;
  }

  const refuse = (code, extra = {}) => ({ decision: TOOL_DECISIONS.REFUSED, code, ...extra });

  /* The verdict for one call, in canonical words. */
  async function judge(call, tool, run, rank, rankOfTool) {
    const organisationId = call.organisationId ?? null;
    let state;
    try { state = await haltState(organisationId); } catch (_error) { return refuse(TOOL_REASONS.UNAVAILABLE); }
    if (state.halted) return refuse(TOOL_REASONS.HALTED, { haltScope: state.scope });
    let settings;
    try { settings = await currentSettings(call); } catch (_error) { return refuse(TOOL_REASONS.UNAVAILABLE); }
    if (settings.enabled === false) return refuse(TOOL_REASONS.DISABLED);
    if (!tool) return refuse(TOOL_REASONS.UNKNOWN_TOOL);
    if (settings.families[tool.family] === false) return refuse(TOOL_REASONS.FAMILY_DISABLED);

    let input = call.input ?? {};
    if (tool.validate) {
      let verdict;
      try { verdict = tool.validate(input); } catch (_error) { verdict = false; }
      if (verdict === false || (isObject(verdict) && verdict.ok === false)) return refuse(TOOL_REASONS.INVALID_INPUT);
      if (isObject(verdict) && verdict.ok === true && 'value' in verdict) input = verdict.value;
    }

    let standing = null;
    if (budget && !tool.budgetExempt) {
      try {
        standing = await budget.check({ scope: call.budgetScope ?? organisationId ?? undefined, limit: settings.budgetLimit, estimate: tool.estimatedCost });
      } catch (_error) { return refuse(TOOL_REASONS.UNAVAILABLE, { input }); }
      if (!standing.allowed) return refuse(TOOL_REASONS.BUDGET, { input, budget: standing });
    }

    if (settings.maxCallsPerRun !== undefined && rank > settings.maxCallsPerRun) return refuse(TOOL_REASONS.CAP, { input, budget: standing });
    if (tool.maxPerRun !== null && rankOfTool > tool.maxPerRun) return refuse(TOOL_REASONS.CAP, { input, budget: standing });

    const pending = (code) => ({ decision: TOOL_DECISIONS.PENDING, code, input, budget: standing });
    if (tool.level === TOOL_LEVELS.SENSITIVE) return pending(TOOL_REASONS.SENSITIVE);
    /* Content read from outside could carry a hidden instruction: a person looks first. */
    if ((run.untrusted || call.untrusted === true) && untrustedLevels.includes(tool.level)) return pending(TOOL_REASONS.UNTRUSTED);
    if (tool.level === TOOL_LEVELS.CONTROLLED && tool.overThreshold) {
      let over = false;
      try { over = tool.overThreshold(input, settings) === true; } catch (_error) { over = true; }
      if (over) return pending(TOOL_REASONS.THRESHOLD);
    }
    return { decision: TOOL_DECISIONS.ALLOWED, code: null, input, budget: standing };
  }

  /* Canonical result -> the application's words. */
  function present(result) {
    return {
      ...result,
      decision: decisionWords.toApp[result.decision],
      code: result.code == null ? null : codeWords.toApp[result.code],
      reasons: result.code == null ? [] : [codeWords.toApp[result.code]],
      level: result.level == null ? null : levelWords.toApp[result.level]
    };
  }

  async function decideCanonical(call) {
    if (!isObject(call)) throw new GovernorError('invalid_call', 'A tool call must be an object { tool, input, ... }.');
    const run = call.run ?? createRun();
    const name = typeof call.tool === 'string' ? call.tool : call.tool?.name;
    const tool = tools.get(name) ?? null;
    /* Counted at once: calls asked together cannot all slip under a cap. */
    run.calls += 1;
    run.byTool[name] = (run.byTool[name] ?? 0) + 1;
    const verdict = await judge(call, tool, run, run.calls, run.byTool[name]);
    const actor = actorOf(call.actor);
    const record = await audit({
      action: 'tool_decision', organisationId: call.organisationId ?? null, actor,
      tool: String(name ?? '').slice(0, 200), family: tool?.family ?? null, level: tool?.level ?? null,
      decision: verdict.decision, reasons: verdict.code ? [verdict.code] : [],
      inputFingerprint: fingerprintOf(call.input ?? null), callRank: run.calls,
      budget: verdict.budget ? { period: verdict.budget.period, spent: verdict.budget.spent, limit: verdict.budget.limit } : null,
      untrusted: run.untrusted || call.untrusted === true
    });
    return {
      allowed: verdict.decision === TOOL_DECISIONS.ALLOWED, decision: verdict.decision, code: verdict.code ?? null,
      tool: record.tool, family: tool?.family ?? null, level: tool?.level ?? null,
      input: verdict.input ?? call.input ?? null, budget: verdict.budget ?? null, rank: run.calls, auditId: record.id
    };
  }

  /**
   * Decision for ONE call { tool, input, run?, actor?, organisationId?, untrusted?, budgetScope? }.
   * Never throws for a refusal; throws only if the audit journal cannot be written (nothing runs then).
   */
  const decide = async (call) => present(await decideCanonical(call));

  /** True when the actor may pull the kill switch. */
  function mayHalt(actor) {
    if (!actor || !isNonEmptyString(actor.id)) return false;
    return activateRoles ? hasRole(actor, activateRoles) : true;
  }
  /** True when the actor may release it. A model or an engine never does; without releaseRoles, only a human. */
  function mayResume(actor) {
    if (!actor || !isNonEmptyString(actor.id) || NEVER_RELEASE.includes(actor.kind)) return false;
    return releaseRoles ? hasRole(actor, releaseRoles) : actor.kind === 'human';
  }

  async function control(halted, { by, reason, organisationId } = {}) {
    const actor = actorOf(by);
    const scope = organisationId == null ? GLOBAL : String(organisationId);
    const action = halted ? 'tool_halt' : 'tool_resume';
    if (!(halted ? mayHalt(actor) : mayResume(actor))) {
      await audit({ action: `${action}_denied`, organisationId: scope === GLOBAL ? null : scope, actor, decision: 'refused', reasons: ['actor_not_allowed'] });
      throw new GovernorError('actor_not_allowed', halted ? 'This actor may not pull the tool kill switch.' : 'This actor may not release the tool kill switch.');
    }
    const value = { halted, by: actor, reason: reason == null ? null : String(reason).slice(0, 2000), at: iso() };
    await store.setControl(`tools-halt:${scope}`, value);
    await audit({ action, organisationId: scope === GLOBAL ? null : scope, actor, decision: halted ? 'halted' : 'running', reasons: halted && value.reason ? [value.reason] : [] });
    if (halted) {
      for (const running of [...active]) if (scope === GLOBAL || running.organisationId === scope) running.interrupt(TOOL_REASONS.HALTED);
    }
    return value;
  }

  const raceAbort = (promise, signal) => new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });

  /**
   * Decides, then runs `fn(input, { signal, decision })` only when allowed. The kill switch is read before the
   * call and again while it runs (in-process at once, other processes every pollMs); on a stop the signal aborts
   * and the call is cut, even if the tool ignores the signal. A pending or refused call is never run.
   * Returns { ...decision, executed, result? } or, when cut, a refused decision with interrupted: true.
   */
  async function execute(call, fn) {
    if (typeof fn !== 'function') throw new GovernorError('invalid_call', 'execute needs the function to run.');
    const verdict = await decideCanonical(call);
    if (!verdict.allowed) return { ...present(verdict), executed: false, interrupted: false };
    const controller = new globalThis.AbortController();
    let stopped = false;
    const running = {
      organisationId: call.organisationId ?? null,
      interrupt(code) { if (stopped) return; stopped = true; controller.abort(new GovernorError(code, 'The tool call was cut by the emergency stop.')); }
    };
    active.add(running);
    const outer = call.signal;
    const onOuter = () => controller.abort(outer.reason);
    if (outer) { if (outer.aborted) onOuter(); else outer.addEventListener('abort', onOuter, { once: true }); }
    let timer = null;
    if (pollMs > 0) {
      let reading = false;
      timer = setInterval(async () => {
        if (reading) return;
        reading = true;
        try { if ((await haltState(running.organisationId)).halted) running.interrupt(TOOL_REASONS.HALTED); } catch (_error) { running.interrupt(TOOL_REASONS.HALTED); } finally { reading = false; }
      }, pollMs);
      timer.unref?.();
    }
    const outcome = async (kind, extra = {}) => audit({
      action: 'tool_outcome', organisationId: call.organisationId ?? null, actor: actorOf(call.actor), tool: verdict.tool, family: verdict.family, level: verdict.level,
      decision: kind, reasons: extra.reason ? [extra.reason] : [], decisionAuditId: verdict.auditId
    });
    try {
      /* The stop may have been pulled between the decision and now. */
      if ((await haltState(running.organisationId)).halted) running.interrupt(TOOL_REASONS.HALTED);
      const result = await raceAbort(Promise.resolve().then(() => fn(verdict.input, { signal: controller.signal, decision: present(verdict) })), controller.signal);
      await outcome('ok');
      return { ...present(verdict), executed: true, interrupted: false, result };
    } catch (error) {
      if (stopped) {
        await outcome('interrupted', { reason: TOOL_REASONS.HALTED });
        return { ...present({ ...verdict, allowed: false, decision: TOOL_DECISIONS.REFUSED, code: TOOL_REASONS.HALTED }), executed: false, interrupted: true };
      }
      if (outer?.aborted) { await outcome('aborted'); throw error; }
      await outcome('error', { reason: String(error?.name ?? 'Error').slice(0, 100) });
      throw error;
    } finally {
      if (timer) clearInterval(timer);
      outer?.removeEventListener('abort', onOuter);
      active.delete(running);
    }
  }

  /** Tools the model may be offered: none when stopped or disabled, else those whose family is on. */
  async function availableTools(call = {}) {
    try {
      if ((await haltState(call.organisationId ?? null)).halted) return [];
      const settings = await currentSettings(call);
      if (settings.enabled === false) return [];
      return [...tools.values()].filter((tool) => settings.families[tool.family] !== false).map((tool) => tool.name);
    } catch (_error) { return []; }
  }

  const describe = () => [...tools.values()].map((tool) => ({
    name: tool.name, family: tool.family, level: levelWords.toApp[tool.level], maxPerRun: tool.maxPerRun, estimatedCost: tool.estimatedCost, budgetExempt: tool.budgetExempt
  }));

  return Object.freeze({
    version, createRun, decide, execute, availableTools, listTools: describe,
    halt: (opts) => control(true, opts),
    resume: (opts) => control(false, opts),
    isHalted: async (organisationId) => (await haltState(organisationId ?? null)).halted,
    /** Counts what a call really consumed (idempotent on id). Needs a budget. */
    recordSpend: (spend = {}) => {
      if (!budget) throw new GovernorError('budget_invalid', 'This tool policy has no budget.');
      return budget.record({ ...spend, scope: spend.scope ?? spend.organisationId ?? undefined });
    },
    budgetStatus: (query = {}) => {
      if (!budget) throw new GovernorError('budget_invalid', 'This tool policy has no budget.');
      return budget.check({ ...query, scope: query.scope ?? query.organisationId ?? undefined });
    },
    listAudit: (filter = {}) => store.listAudit(filter)
  });
}

module.exports = { createToolPolicy, TOOL_LEVELS, TOOL_DECISIONS, TOOL_REASONS };
