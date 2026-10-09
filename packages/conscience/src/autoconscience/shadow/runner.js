'use strict';
/*
 * Shadow mode (propositions 21 and 32). A candidate strategy, already approved
 * by humans, processes a share of the real requests in silence, in parallel to
 * the stable strategy. Its answers are never returned: they are compared with
 * the stable answers by deterministic metrics and kept, masked, as ShadowRuns.
 *
 *  - every tool of the candidate goes through the P3 sandbox: reads are
 *    simulated or replayed from recordings, writes are never executed and only
 *    journalled as intentions; the candidate has no network and no host object;
 *  - sampling is deterministic, the budget is capped, the governor kill switch
 *    stops everything at once;
 *  - `observe` never blocks the stable answer and never throws;
 *  - the report concludes with a code (never "proven") and can only feed a
 *    PROPOSAL to the governor, never a promotion.
 *
 * No language model is imported here. A candidate may call an injected model
 * only as a sandbox tool (simulated or recorded), never over the network.
 */
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { ConscienceError } = require('../../errors');
const { fingerprintOf, copy } = require('../../governor/util');
const { ready: governorReady, data, agentSource, timeoutOf, invalid, deepFreeze } = require('../experiments/common');
const { sandboxState } = require('../experiments/sandbox');
const { execute } = require('../experiments/execution');
const { statisticsOptions } = require('../experiments/common');
const { number } = require('../statistics');
const { maskerOf, actorOf, isNonEmptyString } = require('../vigilance/common');
const { resolveCandidate } = require('./candidate');
const { buildReport } = require('./report');
const { createMemoryShadowStore, SHADOW_STORE_METHODS, SHADOW_RUN_LIMIT, shadowEraser } = require('./store');

const MAX_STORED_CHARS = 20000;
const METRIC_NAME = /^[a-z][a-z0-9_]{0,60}$/;
const bindingOf = (options) => ({ governor: options.governor, organisationId: options.organisationId });
const isHalt = (error) => error?.code === 'governor_halted';

function metricsOf(list, target, limits) {
  if (!Array.isArray(list) || !list.length || list.length > 20) invalid('metrics must be a non-empty list (at most 20).');
  const names = new Set();
  const out = list.map((metric) => {
    if (!metric || typeof metric.name !== 'string' || !METRIC_NAME.test(metric.name) || typeof metric.score !== 'function') invalid('A metric needs a name and a score({ input, output, side }) function.');
    if (names.has(metric.name)) invalid('Duplicate metric name.');
    names.add(metric.name);
    if (metric.critical != null && typeof metric.critical !== 'boolean') invalid('critical must be a boolean.');
    const maxRegression = metric.maxRegression == null ? 0.02 : number(metric.maxRegression, 'maxRegression', 0, 1);
    return Object.freeze({ name: metric.name, score: metric.score, critical: metric.critical === true, maxRegression });
  });
  if (typeof target !== 'string' || !names.has(target)) invalid('target must name one of the metrics.');
  if (out.length < 2 && limits.cost == null) invalid('Anti-Goodhart: declare at least one counter-measure besides the target (another metric, or limits.cost).');
  return out;
}

function limitsOf(input) {
  if (input == null) return {};
  if (typeof input !== 'object') invalid('limits must be an object.');
  return input.cost == null ? {} : { cost: number(input.cost, 'limits.cost', 0) };
}

function budgetOf(input, timeoutMs) {
  if (!input || typeof input !== 'object') invalid('A budget is required: { maxRuns?, maxCost?, maxDurationMs? } with at least one cap.');
  const out = { costPerRun: input.costPerRun == null ? 1 : number(input.costPerRun, 'budget.costPerRun', 0), costOf: input.costOf ?? null, governorAgentId: input.governorAgentId ?? null };
  if (out.costOf != null && typeof out.costOf !== 'function') invalid('budget.costOf must be a function.');
  if (out.governorAgentId != null && !isNonEmptyString(out.governorAgentId)) invalid('budget.governorAgentId must be a non-empty string.');
  for (const key of ['maxRuns', 'maxCost', 'maxDurationMs']) out[key] = input[key] == null ? null : number(input[key], `budget.${key}`, 0);
  if (out.maxRuns != null && !Number.isInteger(out.maxRuns)) invalid('budget.maxRuns must be an integer.');
  if (out.maxRuns == null && out.maxCost == null && out.maxDurationMs == null) invalid('A budget needs at least one cap (maxRuns, maxCost or maxDurationMs).');
  out.maxRuns = Math.min(out.maxRuns ?? SHADOW_RUN_LIMIT, SHADOW_RUN_LIMIT);
  void timeoutMs;
  return out;
}

/** Mask every string of a plain JSON value. Own `__proto__` keys stay ordinary data. */
async function maskData(mask, value, depth = 0) {
  if (typeof value === 'string') {
    const masked = await mask(value);
    if (typeof masked !== 'string') throw new ConscienceError('masker_invalid', 'The masker must return a string.');
    return masked;
  }
  if (value == null || typeof value !== 'object' || depth > 32) return value;
  if (Array.isArray(value)) return Promise.all(value.map((item) => maskData(mask, item, depth + 1)));
  const entries = [];
  for (const key of Object.keys(value)) entries.push([key, await maskData(mask, value[key], depth + 1)]);
  return Object.fromEntries(entries);
}

async function storable(mask, value) {
  const masked = await maskData(mask, value);
  const text = JSON.stringify(masked);
  if (text !== undefined && text.length > MAX_STORED_CHARS) return { masked: { truncated: true, size: text.length, fingerprint: fingerprintOf(masked) }, fingerprint: fingerprintOf(masked) };
  return { masked, fingerprint: fingerprintOf(masked) };
}

function mergeRecordings(config, recordings) {
  if (!recordings) return config;
  const out = copy(config);
  for (const [tool, list] of Object.entries(recordings)) {
    if (!Object.hasOwn(out, tool) || out[tool].kind !== 'read') invalid(`Recordings are for read tools of the sandbox only (${tool}).`);
    if (!Array.isArray(list) || !list.every((r) => r && Object.hasOwn(r, 'input') && Object.hasOwn(r, 'output'))) invalid('recordings must contain input/output pairs.');
    out[tool].recordings = [...list, ...(out[tool].recordings ?? [])];
  }
  return out;
}

function scoreStatus(value) {
  if (value === true) return 'succeeded';
  if (value === false) return 'failed';
  return 'unknown';
}

/**
 * @returns {Promise<ShadowRunner>}
 */
async function createShadowRunner(options = {}) {
  await governorReady(options);
  const binding = bindingOf(options);
  const { governor, organisationId } = binding;
  const mask = maskerOf(options.masker);
  const store = options.store ?? createMemoryShadowStore();
  for (const method of SHADOW_STORE_METHODS) if (typeof store[method] !== 'function') throw new ConscienceError('store_invalid', `Shadow store is missing ${method}().`);
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();

  const candidateInput = options.candidate;
  if (!candidateInput || typeof candidateInput !== 'object') invalid('candidate is required: { agent, proposalId } or { agent, kind, id }.');
  const source = agentSource(candidateInput.agent);
  const reference = { proposalId: candidateInput.proposalId, kind: candidateInput.kind, id: candidateInput.id, versionId: candidateInput.versionId };
  const verified = await resolveCandidate(governor, organisationId, reference);

  if (!options.sandbox) invalid('A sandbox created with createSandbox() is required: the candidate has no other way to use a tool.');
  const sandboxConfig = (await sandboxState(options.sandbox, binding)).config;

  const sampleRate = number(options.sampleRate, 'sampleRate', Number.MIN_VALUE, 1);
  const timeoutMs = timeoutOf(options.timeoutMs);
  const budget = budgetOf(options.budget, timeoutMs);
  const limits = limitsOf(options.limits);
  const metrics = metricsOf(options.metrics, options.target, limits);
  const target = options.target;
  const defaults = { ...statisticsOptions(options),
    maxCriticalRegressions: options.maxCriticalRegressions == null ? 0 : number(options.maxCriticalRegressions, 'maxCriticalRegressions', 0),
    maxIncidentRate: options.maxIncidentRate == null ? 0.05 : number(options.maxIncidentRate, 'maxIncidentRate', 0, 1) };
  const maxConcurrent = options.maxConcurrent == null ? 4 : number(options.maxConcurrent, 'maxConcurrent', 1, 64);
  const deadlineMs = options.deadlineMs == null ? timeoutMs + 3000 : number(options.deadlineMs, 'deadlineMs', 10);

  const agentFingerprint = fingerprintOf(source);
  const shadowId = options.id ?? `shadow_${fingerprintOf({ organisationId, candidate: verified.fingerprint, agent: agentFingerprint, sandbox: fingerprintOf(sandboxConfig) }).slice(0, 24)}`;
  if (!isNonEmptyString(shadowId)) invalid('id must be a non-empty string.');
  const descriptor = deepFreeze({ source: verified.source, kind: verified.kind, id: verified.id, versionId: verified.versionId, proposalId: verified.proposalId,
    fingerprint: verified.fingerprint, agentFingerprint });

  const stats = { seen: 0, sampled: 0, executed: 0, recorded: 0, skipped: {}, errors: {} };
  const bump = (bag, key) => { bag[key] = (bag[key] ?? 0) + 1; };
  let stopped = null;
  const stop = (reason) => { if (!stopped) stopped = { reason, at: iso() }; };
  const inflight = new Set();
  const pending = new Set();

  /* ---- budget: runs and cost are reserved before a run, time is settled after ---- */
  let used = null;
  const loading = (async () => {
    const runs = await store.listShadowRuns({ organisationId, shadowId, limit: SHADOW_RUN_LIMIT });
    used = { runs: runs.length, cost: runs.reduce((s, r) => s + (r.cost ?? 0), 0), durationMs: runs.reduce((s, r) => s + (r.durationMs ?? 0), 0) };
  })();
  loading.catch(() => {}); // The failure is raised again, inside the run that needs the totals.
  async function reserve() {
    await loading;
    const full = used.runs + 1 > budget.maxRuns || (budget.maxCost != null && used.cost + budget.costPerRun > budget.maxCost)
      || (budget.maxDurationMs != null && used.durationMs >= budget.maxDurationMs);
    if (full) return null;
    used.runs += 1; used.cost += budget.costPerRun;
    return { cost: budget.costPerRun };
  }
  const release = (ticket) => { if (ticket) { used.runs -= 1; used.cost -= ticket.cost; } };
  const settle = (ticket, cost, durationMs) => { used.cost += cost - ticket.cost; used.durationMs += durationMs; };

  const sampled = (requestId) => crypto.createHash('sha256').update(`${shadowId}\u0000${requestId}`).digest().readUIntBE(0, 6) / 2 ** 48 < sampleRate;

  async function stillAllowed() {
    try { await governorReady(binding); } catch (error) {
      if (isHalt(error)) { stop('governor_halted'); return 'governor_halted'; }
      return 'governor_unavailable';
    }
    try {
      const current = await resolveCandidate(governor, organisationId, reference);
      if (current.fingerprint !== verified.fingerprint) { stop('candidate_changed'); return 'candidate_changed'; }
    } catch (error) {
      if (isHalt(error)) { stop('governor_halted'); return 'governor_halted'; }
      stop('candidate_unavailable'); return 'candidate_unavailable';
    }
    return null;
  }

  async function scoreRun({ input, candidateOutput, completed, stableOutput }, incidents) {
    const scores = {};
    const one = async (metric, output, side) => {
      try {
        const verdict = await metric.score({ input: copy(input), output: copy(output), side });
        if (verdict !== true && verdict !== false && verdict != null) { incidents.add('scoring_invalid'); return 'unknown'; }
        return scoreStatus(verdict);
      } catch (_error) { incidents.add('scoring_failed'); return 'unknown'; }
    };
    for (const metric of metrics) {
      // A candidate that produced nothing cannot have succeeded: it is a failure of the candidate, not an unknown.
      scores[metric.name] = { candidate: completed ? await one(metric, candidateOutput, 'candidate') : 'failed', stable: await one(metric, stableOutput, 'stable') };
    }
    return scores;
  }

  async function pipeline(prepared, control) {
    const { request, stableResult, recordings, runKey } = prepared;
    const refusal = await stillAllowed();
    if (refusal) { bump(stats.skipped, refusal); return { status: 'skipped', reason: refusal }; }
    if (await store.getShadowRun(organisationId, runKey)) { bump(stats.skipped, 'duplicate'); return { status: 'skipped', reason: 'duplicate' }; }

    const ticket = await reserve();
    if (!ticket) { stop('budget_exhausted'); bump(stats.skipped, 'budget_exhausted'); return { status: 'skipped', reason: 'budget_exhausted' }; }
    try {
      if (budget.governorAgentId) {
        const spend = await governor.authorizeSpend({ organisationId, id: `shadow:${runKey}`, agentId: budget.governorAgentId, cycleId: shadowId, cost: budget.costPerRun });
        if (!spend.allowed) {
          const halted = spend.reasons.includes('governor_halted');
          stop(halted ? 'governor_halted' : 'governor_budget'); release(ticket); bump(stats.skipped, stopped.reason);
          return { status: 'skipped', reason: stopped.reason };
        }
      }
      const config = mergeRecordings(sandboxConfig, recordings);
      const started = performance.now();
      stats.executed += 1;
      const result = await execute({ governor, organisationId, source, input: { input: request.input, version: verified.content }, config, timeoutMs });
      const durationMs = Math.round(performance.now() - started);
      const incidents = new Set();
      const completed = result.status === 'completed';
      if (!completed) incidents.add(result.reason === 'timeout' ? 'candidate_timeout' : 'candidate_failed');
      const candidateOutput = completed ? (result.output ?? null) : null;
      const journal = completed ? (result.journal ?? []) : [];
      const writes = journal.filter((entry) => entry.kind === 'write');

      const scores = await scoreRun({ input: request.input, candidateOutput, completed, stableOutput: stableResult.output }, incidents);
      let cost = budget.costPerRun;
      if (budget.costOf) {
        try {
          const value = budget.costOf({ durationMs, status: completed ? 'completed' : 'failed', writeIntentions: writes.length, output: copy(candidateOutput) });
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            // costPerRun is the ceiling reserved for a run: a run cannot cost more than the budget set aside for it.
            cost = Math.min(value, budget.costPerRun);
            if (value > budget.costPerRun) incidents.add('cost_over_ceiling');
          } else incidents.add('cost_invalid');
        } catch (_error) { incidents.add('cost_invalid'); }
      }
      const agreement = completed && fingerprintOf(candidateOutput) === fingerprintOf(stableResult.output);

      // Privacy first: nothing leaves this function unmasked, and a masker failure keeps the run out of the store.
      const maskedInput = await storable(mask, request.input);
      const maskedCandidate = await storable(mask, candidateOutput);
      const maskedStable = await storable(mask, stableResult.output);
      const intentions = [];
      for (const entry of writes) intentions.push({ sequence: entry.sequence, tool: entry.tool, input: (await storable(mask, entry.input)).masked });

      const record = {
        id: runKey, shadowId, organisationId, userId: request.userId, createdAt: iso(), sampleRate,
        candidate: { ...copy(descriptor), status: completed ? 'completed' : result.reason === 'timeout' ? 'timeout' : 'error', reason: completed ? null : result.reason ?? 'execution_failed',
          output: maskedCandidate.masked, outputFingerprint: maskedCandidate.fingerprint },
        request: { input: maskedInput.masked, fingerprint: maskedInput.fingerprint },
        stable: { output: maskedStable.masked, outputFingerprint: maskedStable.fingerprint, durationMs: stableResult.durationMs },
        scores, agreement, writeIntentions: intentions, toolCalls: { read: journal.length - writes.length, write: writes.length },
        durationMs, cost, stableCost: stableResult.cost, incidents: [...incidents].sort()
      };
      if (control.abandoned) { release(ticket); return { status: 'timeout', reason: 'deadline' }; }
      // The kill switch is read again right before writing: a run finished after the stop is dropped.
      try { await governorReady(binding); } catch (error) {
        release(ticket);
        if (isHalt(error)) { stop('governor_halted'); bump(stats.skipped, 'governor_halted'); return { status: 'skipped', reason: 'governor_halted' }; }
        throw error;
      }
      const { created } = await store.putShadowRun(record);
      settle(ticket, cost, durationMs);
      if (created) stats.recorded += 1;
      // The acknowledgement carries no output of the candidate: nothing here can be forwarded to a user by mistake.
      return { status: 'recorded', runId: runKey, created };
    } catch (error) {
      release(ticket);
      throw error;
    }
  }

  function prepare(input) {
    const request = input?.request, stableResult = input?.stableResult;
    if (!request || typeof request !== 'object' || !isNonEmptyString(request.id)) invalid('request needs a stable id.');
    if (request.userId != null && !isNonEmptyString(request.userId)) invalid('userId must be a non-empty string.');
    if (!stableResult || typeof stableResult !== 'object' || !Object.hasOwn(stableResult, 'output')) invalid('stableResult needs the output of the stable strategy.');
    const optionalNumber = (value, label) => (value == null ? null : number(value, label, 0));
    const recordings = input.recordings == null ? null : data(input.recordings);
    return {
      request: { id: request.id, userId: request.userId ?? null, input: data(request.input === undefined ? null : request.input) },
      stableResult: { output: data(stableResult.output === undefined ? null : stableResult.output), durationMs: optionalNumber(stableResult.durationMs, 'stableResult.durationMs'), cost: optionalNumber(stableResult.cost, 'stableResult.cost') },
      recordings, runKey: `shadowrun_${fingerprintOf({ shadowId, requestId: request.id }).slice(0, 32)}`
    };
  }

  function observe(input) {
    const immediate = (status, reason) => ({ scheduled: false, reason, done: Promise.resolve({ status, reason }) });
    try {
      stats.seen += 1;
      let prepared;
      try { prepared = prepare(input); } catch (_error) { bump(stats.errors, 'invalid_input'); return immediate('rejected', 'invalid_input'); }
      if (stopped) { bump(stats.skipped, stopped.reason); return immediate('skipped', stopped.reason); }
      if (!sampled(prepared.request.id)) { bump(stats.skipped, 'not_sampled'); return immediate('skipped', 'not_sampled'); }
      if (inflight.has(prepared.runKey)) { bump(stats.skipped, 'duplicate'); return immediate('skipped', 'duplicate'); }
      if (inflight.size >= maxConcurrent) { bump(stats.skipped, 'busy'); return immediate('skipped', 'busy'); }
      stats.sampled += 1;
      inflight.add(prepared.runKey);
      const control = { abandoned: false };
      let timer;
      const deadline = new Promise((resolve) => { timer = setTimeout(() => { control.abandoned = true; resolve({ status: 'timeout', reason: 'deadline' }); }, deadlineMs); timer.unref?.(); });
      // Errors are isolated: whatever happens, `done` resolves and carries no message of the candidate.
      const work = pipeline(prepared, control).catch((error) => {
        if (isHalt(error)) { stop('governor_halted'); bump(stats.skipped, 'governor_halted'); return { status: 'skipped', reason: 'governor_halted' }; }
        const code = typeof error?.code === 'string' ? error.code : 'shadow_failed';
        bump(stats.errors, code);
        return { status: 'error', reason: code };
      });
      const done = Promise.race([work, deadline]).finally(() => { clearTimeout(timer); inflight.delete(prepared.runKey); pending.delete(done); });
      pending.add(done);
      return { scheduled: true, reason: null, done };
    } catch (_error) {
      return immediate('error', 'shadow_failed');
    }
  }

  async function flush() { await Promise.allSettled([...pending]); }

  async function listRuns(input = {}) {
    await governorReady(binding);
    return store.listShadowRuns({ organisationId, shadowId, limit: input.limit });
  }

  async function report(input = {}) {
    await governorReady(binding);
    const reportOptions = { ...defaults, ...(input.minimumSample != null || input.level != null ? statisticsOptions({ ...defaults, ...input }) : {}) };
    const runs = await store.listShadowRuns({ organisationId, shadowId, limit: SHADOW_RUN_LIMIT });
    if (runs.length >= SHADOW_RUN_LIMIT) throw new ConscienceError('evaluation_limit', 'Too many shadow runs for one report: stop this shadow and start a new one.');
    const body = buildReport({ runs, metrics, target, options: reportOptions, limits });
    const result = {
      organisationId, shadowId, candidate: copy(descriptor), generatedAt: iso(), ...body,
      stopped: stopped && { ...stopped },
      provesImprovement: false, causality: 'not_established', applied: false, proposal: null, finding: null
    };
    const digest = fingerprintOf({ conclusion: result.conclusion, reasons: result.reasons, sample: result.sample, metrics: result.metrics, target });
    if (input.propose && result.conclusion === 'promising') {
      const proposedBy = actorOf(input.propose.proposedBy, { kind: 'engine', id: 'shadow-runner' });
      // The recommendation is a proposal like any other: a human decides, and deployChange / promoteChange stay theirs to call.
      result.proposal = await governor.evaluatePolicy({
        organisationId, target: { kind: descriptor.kind, id: `shadow:${descriptor.id}:${descriptor.versionId ?? descriptor.proposalId}` },
        change: { shadowEvidence: { conclusion: result.conclusion, runs: result.sample.runs, reportFingerprint: digest, candidateFingerprint: descriptor.fingerprint, recommendation: 'review_for_gradual_deployment' } },
        justification: { code: 'shadow_promising', target, reasons: result.reasons, interval: result.metrics[target].difference },
        risk: input.propose.risk ?? 'medium', proposedBy, owner: input.propose.owner ?? null
      });
    }
    if (input.recordedBy) {
      result.finding = await governor.recordFinding({
        organisationId, runId: shadowId, code: `shadow_${result.conclusion}`, severity: result.conclusion === 'regression' ? 'high' : 'info',
        subject: { kind: 'shadow', id: shadowId }, evidenceRefs: result.criticalRegressions.map((c) => c.runId), sampleSize: result.sample.runs,
        metrics: { conclusion: result.conclusion, reasons: result.reasons, reportFingerprint: digest }, recordedBy: actorOf(input.recordedBy)
      });
    }
    return result;
  }

  async function eraseSubject({ organisationId: org, userId } = {}) {
    governor.assertSingleOrganisation(organisationId, org);
    if (!isNonEmptyString(userId)) invalid('eraseSubject needs organisationId and userId.');
    return { removed: await store.removeShadowRuns({ organisationId, userId }) };
  }

  return Object.freeze({
    id: shadowId, candidate: descriptor, sampleRate, observe, report, flush, listRuns, eraseSubject,
    eraser: shadowEraser(store),
    stats: () => ({ ...stats, skipped: { ...stats.skipped }, errors: { ...stats.errors }, inflight: inflight.size, stopped: stopped && { ...stopped } }),
    isStopped: () => stopped !== null
  });
}

module.exports = { createShadowRunner };
