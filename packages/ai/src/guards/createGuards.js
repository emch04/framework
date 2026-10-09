'use strict';
const crypto = require('crypto');
const { createReversibleMasker } = require('../masking');
const { frameUntrusted, windowsOf } = require('./frame');
const { findPersonalData } = require('./leaks');

/**
 * Guards for an AI agent, independent of the AI provider.
 *
 * Four async functions, each taking a `run` (one per conversation or agent
 * run, from `guards.newRun()`):
 *
 *   input(text, run)             names and personal data masked before the text leaves
 *   toolResult(result, run, ctx) outside content checked for injection, framed as data
 *   output(text, run, ctx)       unmasked, then grounding, personal-data leak, moderation
 *   beforeAction(action, run)    refuses any action once an injection is suspected,
 *                                until a human confirmed it
 *
 * Every call answers a decision (`allow`, `flag`, `block`) and emits one event
 * for logging. Events carry numbers, categories and codes — never the text.
 * When a model of the service is down the guard follows the policy: `failClosed`
 * (block and signal) or `failOpen` (continue and signal `degraded`).
 */

const FAIL_CLOSED = 'failClosed';
const FAIL_OPEN = 'failOpen';
const DECISIONS = Object.freeze(['allow', 'flag', 'block']);
const SEVERITY = { allow: 0, flag: 1, block: 2 };
const DEFAULT_MAX_SCAN_CHARS = 100000;
const WITHHELD = '[content withheld by a guard]';

const keyHash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

/** Personal-data keys the person gave, kept as hashes: enough to recognise them, never to read them. */
class KeySet {
  constructor(hashes = []) { this.hashes = new Set(hashes); }
  add(key) { this.hashes.add(keyHash(key)); return this; }
  has(key) { return this.hashes.has(keyHash(key)); }
  list() { return [...this.hashes]; }
}

const worst = (a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a);

function normalisePolicy(policy = {}) {
  const failure = { action: FAIL_CLOSED, read: FAIL_CLOSED, ...(policy.failure || {}) };
  for (const mode of ['action', 'read']) {
    if (failure[mode] !== FAIL_CLOSED && failure[mode] !== FAIL_OPEN) {
      throw new TypeError(`policy.failure.${mode}: "failClosed" or "failOpen" expected.`);
    }
  }
  const choice = (name, value, allowed, fallback) => {
    const picked = value === undefined ? fallback : value;
    if (!allowed.includes(picked)) throw new TypeError(`policy.${name}: one of ${allowed.join(', ')}.`);
    return picked;
  };
  return {
    failure,
    onInjection: choice('onInjection', policy.onInjection, ['flag', 'withhold'], 'flag'),
    onLeak: choice('onLeak', policy.onLeak, ['block', 'redact', 'flag'], 'block'),
    onModeration: choice('onModeration', policy.onModeration, ['block', 'flag'], 'block'),
    onUnsupported: choice('onUnsupported', policy.onUnsupported, ['flag', 'block'], 'flag')
  };
}

function lazyVerifySources() {
  try {
    return require('@astratra/rag').verifySources;
  } catch (_error) {
    return null;
  }
}

/**
 * @param {object} options
 * @param {object} options.models    client from @astratra/models (injected, never imported).
 * @param {object} [options.policy]  { failure: { action, read }, onInjection, onLeak, onModeration, onUnsupported }.
 * @param {Function} [options.onEvent]
 * @param {string[]} [options.names]  register names always masked.
 * @param {string[]} [options.entityLabels] default ['person'].
 * @param {object} [options.injection] { threshold = 0.5, actionThreshold = threshold, maxScanChars, chunkChars, overlapChars }.
 * @param {object} [options.output]  { grounding = true, leak = true, moderation = true, minSupport = 0.5, leakTypes }.
 * @param {Function} [options.verifySources] (answer, sources, { nli }) => report; default: @astratra/rag if installed.
 * @param {'action'|'read'} [options.defaultMode] mode of a run that does not name one. Default 'action'.
 * @param {Function} [options.nonce] () => string, for tests.
 */
function createGuards(options = {}) {
  const models = options.models || null;
  const policy = normalisePolicy(options.policy);
  const listeners = new Set();
  const emit = (event) => {
    for (const listener of [options.onEvent, ...listeners]) {
      if (typeof listener !== 'function') continue;
      try { listener(event); } catch (_error) { /* observers never break a guard */ }
    }
  };
  const now = options.now || (() => new Date().toISOString());
  const labels = options.entityLabels || ['person'];
  const injectionOptions = options.injection || {};
  const injectionThreshold = injectionOptions.threshold === undefined ? 0.5 : injectionOptions.threshold;
  const actionThreshold = injectionOptions.actionThreshold === undefined ? injectionThreshold : injectionOptions.actionThreshold;
  const maxScanChars = injectionOptions.maxScanChars || DEFAULT_MAX_SCAN_CHARS;
  const chunkChars = injectionOptions.chunkChars || 6000;
  const overlapChars = injectionOptions.overlapChars === undefined ? 300 : injectionOptions.overlapChars;
  const outputOptions = { grounding: true, leak: true, moderation: true, minSupport: 0.5, ...(options.output || {}) };
  const verifySources = options.verifySources || (outputOptions.grounding ? lazyVerifySources() : null);

  const closed = (run) => policy.failure[run.mode] === FAIL_CLOSED;
  const available = (endpoint) => Boolean(models && typeof models[endpoint] === 'function');

  function decide(guard, run, base) {
    const event = {
      type: 'guard', guard, runId: run.id, mode: run.mode, at: now(),
      decision: base.decision, reasons: base.reasons, degraded: base.degraded, metrics: base.metrics || {}
    };
    emit(event);
    return event;
  }

  /* ---- run -------------------------------------------------------------- */

  function newRun(runOptions = {}) {
    const mode = runOptions.mode === undefined ? (options.defaultMode || 'action') : runOptions.mode;
    if (mode !== 'action' && mode !== 'read') throw new TypeError('mode: "action" or "read".');
    const kinds = new Map();
    const run = {
      id: runOptions.id || crypto.randomBytes(6).toString('hex'),
      mode,
      /** Raw texts read from outside during this run: what the reply is checked against. */
      sources: [...(runOptions.sources || [])],
      /** Set when an injection is suspected: no action without a human, for the rest of the run. */
      requiresConfirmation: false,
      suspicions: 0,
      /** Personal data given by the person in this run: a reply may repeat it. */
      allowed: new KeySet(),
      detection: { failed: false },
      masker: null
    };
    run.masker = createReversibleMasker({
      names: [...(options.names || []), ...(runOptions.names || [])],
      typeOf: (value) => kinds.get(value) || 'PERSON',
      detectTypes: labels,
      token: (type, n) => `#${String(type).toUpperCase()}_${String(n).padStart(4, '0')}`
    });
    run.kinds = kinds;
    run.unmask = (text) => run.masker.unmask(text);
    return run;
  }

  /* ---- keeping a run across a restart ------------------------------------ */

  /**
   * The state of a run as plain JSON: the masking table, the confirmation flag,
   * hashes of the personal data the person gave, and the external texts read,
   * masked. No other raw text. The table holds the real values (that is how a
   * reply is unmasked): store it like the data it protects.
   */
  function exportRun(run) {
    const sources = run.sources.map((text) => run.masker.mask(text));
    return {
      version: 1,
      id: run.id,
      mode: run.mode,
      requiresConfirmation: run.requiresConfirmation,
      suspicions: run.suspicions,
      allowed: run.allowed.list(),
      kinds: [...run.kinds.entries()],
      sources,
      masker: run.masker.snapshot()
    };
  }

  /** A run identical to the one `exportRun` described. */
  function restoreRun(state) {
    if (!state || state.version !== 1 || typeof state.id !== 'string' || !Array.isArray(state.allowed) || !Array.isArray(state.kinds) || !Array.isArray(state.sources)) {
      throw new TypeError('restoreRun: invalid snapshot.');
    }
    const run = newRun({ id: state.id, mode: state.mode });
    run.masker.restore(state.masker);
    run.requiresConfirmation = state.requiresConfirmation === true;
    run.suspicions = Number.isInteger(state.suspicions) ? state.suspicions : 0;
    run.allowed = new KeySet(state.allowed);
    for (const [value, type] of state.kinds) run.kinds.set(value, type);
    run.sources = state.sources.map((text) => run.masker.unmask(text));
    return run;
  }

  /* ---- input ------------------------------------------------------------ */

  async function detectNames(text, run) {
    if (!available('entities')) return null;
    const names = [];
    const pieces = windowsOf(text, 1200, 0);
    for (const piece of pieces) {
      const found = await models.entities(piece, labels);
      if (!found.ok) { run.detection.failed = true; return null; }
      for (const entity of found.entities) if (entity.score >= 0.6 && entity.text.trim().length >= 3) names.push(entity.text.trim());
    }
    return names;
  }

  async function input(text, run) {
    if (typeof text !== 'string' || !text) return { decision: 'allow', text, degraded: [], masked: 0 };
    const degraded = [];
    const reasons = [];
    run.detection.failed = false;
    let names = [];
    if (available('entities')) {
      const detected = await detectNames(text, run);
      if (detected) names = detected;
      else degraded.push('entities');
    } else {
      degraded.push('entities');
    }
    const structured = findPersonalData(text);
    for (const item of structured) {
      run.kinds.set(item.value, item.type.toUpperCase());
      run.allowed.add(item.key);
    }
    const before = run.masker.size();
    const masked = run.masker.mask(text, { names: [...names, ...structured.map((s) => s.value)] });
    const count = run.masker.size() - before;
    let decision = 'allow';
    if (degraded.length) {
      reasons.push('entities_unavailable');
      if (closed(run)) decision = 'block';
    }
    const event = decide('input', run, {
      decision, reasons, degraded, metrics: { chars: text.length, maskedValues: count, structured: structured.length }
    });
    return { decision, text: decision === 'block' ? null : masked, degraded, masked: count, event };
  }

  /* ---- toolResult --------------------------------------------------------- */

  async function scanForInjection(content, threshold) {
    const pieces = windowsOf(content, chunkChars, overlapChars);
    let max = 0;
    for (let i = 0; i < pieces.length; i += 8) {
      const result = await models.injection(pieces.slice(i, i + 8));
      if (!result.ok) return { failed: result.code };
      for (const r of result.results) max = Math.max(max, r.score);
    }
    return { score: max, suspected: max >= threshold, chunks: pieces.length };
  }

  async function toolResult(result, run, context = {}) {
    const marked = result && typeof result === 'object' && !Array.isArray(result) && 'content' in result && result.untrusted !== undefined;
    const external = context.external === true || (marked && result.untrusted === true);
    const payload = marked ? result.content : result;
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload === undefined ? null : payload);
    const source = context.tool || 'tool';
    if (!external) {
      /* A tool the app trusts: what it returns is data the person may see repeated. */
      for (const item of findPersonalData(raw)) run.allowed.add(item.key);
      const masked = await maskOutbound(raw, run);
      decide('toolResult', run, { decision: 'allow', reasons: ['trusted'], degraded: [], metrics: { chars: raw.length } });
      return { decision: 'allow', content: masked, framed: false, suspected: false, degraded: [] };
    }
    run.sources.push(raw);
    let content = raw;
    let truncated = false;
    if (content.length > maxScanChars) { content = content.slice(0, maxScanChars); truncated = true; }
    const reasons = [];
    const degraded = [];
    let decision = 'allow';
    let suspected = false;
    let score = null;
    let chunks = 0;
    if (!available('injection')) {
      degraded.push('injection');
    } else {
      const scan = await scanForInjection(content, run.mode === 'action' ? actionThreshold : injectionThreshold);
      if (scan.failed) degraded.push('injection');
      else ({ score, suspected, chunks } = scan);
    }
    if (degraded.length) {
      reasons.push('injection_check_unavailable');
      if (closed(run)) { decision = 'block'; suspected = true; }
    }
    if (suspected) {
      reasons.push(degraded.length ? 'unverified_external_content' : 'injection_suspected');
      run.requiresConfirmation = true;
      run.suspicions += 1;
      if (decision !== 'block') decision = policy.onInjection === 'withhold' ? 'block' : 'flag';
    }
    if (truncated) reasons.push('truncated');
    const body = decision === 'block' ? WITHHELD : await maskOutbound(content, run);
    const framed = frameUntrusted(body, { source, nonce: options.nonce ? options.nonce() : undefined });
    decide('toolResult', run, {
      decision, reasons, degraded, metrics: { chars: raw.length, chunks, score, requiresConfirmation: run.requiresConfirmation }
    });
    return { decision, content: framed, framed: true, suspected, score, degraded, requiresConfirmation: run.requiresConfirmation, truncated };
  }

  async function maskOutbound(text, run) {
    if (!text) return text;
    return run.masker.mask(text);
  }

  /* ---- output ------------------------------------------------------------- */

  function checkLeaks(text, run) {
    const found = findPersonalData(text, outputOptions.leakTypes);
    const allow = typeof outputOptions.allowLeak === 'function' ? outputOptions.allowLeak : () => false;
    return found.filter((item) => !run.allowed.has(item.key) && !allow(item, run));
  }

  async function checkGrounding(restored, run, extraSources) {
    const sources = [...run.sources, ...(extraSources || [])];
    if (!sources.length) return { checked: false, reason: 'no_sources' };
    if (!verifySources) return { checked: false, reason: 'not_configured' };
    if (!available('nli')) return { checked: false, reason: 'unavailable' };
    const nli = async (pairs) => {
      const result = await models.nli(pairs);
      if (!result.ok) throw new Error(result.code);
      return result.results;
    };
    const report = await verifySources(restored, sources, { nli });
    if (!report || report.code !== 'OK') return { checked: false, reason: 'unavailable' };
    const claims = report.claims;
    const supported = claims.filter((c) => c.category === 'SUPPORTED').length;
    const unsupported = claims.filter((c) => c.category !== 'SUPPORTED');
    return {
      checked: true,
      score: claims.length ? supported / claims.length : 1,
      claims: claims.length,
      contradicted: claims.filter((c) => c.category === 'CONTRADICTED').length,
      unsupported: unsupported.map((c) => ({ claim: c.claim, contradicted: c.category === 'CONTRADICTED' }))
    };
  }

  async function output(text, run, context = {}) {
    if (typeof text !== 'string' || !text) return { decision: 'allow', text, degraded: [], reasons: [] };
    const restored = run.unmask(text);
    const reasons = [];
    const degraded = [];
    let decision = 'allow';
    const failure = (name) => {
      degraded.push(name);
      reasons.push(`${name}_unavailable`);
      if (closed(run)) decision = worst(decision, 'block');
    };
    let finalText = restored;
    let leaks = [];
    let moderation = null;
    let grounding = { checked: false, reason: 'disabled' };

    if (outputOptions.leak) {
      leaks = checkLeaks(restored, run);
      if (leaks.length) {
        reasons.push('personal_data_leak');
        decision = worst(decision, policy.onLeak === 'block' ? 'block' : 'flag');
        if (policy.onLeak === 'redact') {
          finalText = [...leaks].reverse().reduce((t, l) => `${t.slice(0, l.start)}[${l.type} removed]${t.slice(l.end)}`, restored);
        }
      }
    }
    if (outputOptions.moderation) {
      if (!available('moderation')) failure('moderation');
      else {
        const pieces = windowsOf(restored, 6000, 300);
        let flagged = false;
        const categories = new Set();
        let unsafe = 0;
        let failed = false;
        for (let i = 0; i < pieces.length && !failed; i += 8) {
          const result = await models.moderation(pieces.slice(i, i + 8));
          if (!result.ok) { failed = true; break; }
          for (const r of result.results) {
            flagged = flagged || r.flagged;
            unsafe = Math.max(unsafe, r.unsafe);
            r.flaggedCategories.forEach((c) => categories.add(c));
          }
        }
        if (failed) failure('moderation');
        else {
          moderation = { flagged, unsafe, categories: [...categories] };
          if (flagged) { reasons.push('moderation_flagged'); decision = worst(decision, policy.onModeration); }
        }
      }
    }
    if (outputOptions.grounding) {
      try {
        grounding = await checkGrounding(restored, run, context.sources);
      } catch (_error) {
        grounding = { checked: false, reason: 'unavailable' };
      }
      if (!grounding.checked && grounding.reason === 'unavailable') failure('grounding');
      if (grounding.checked && grounding.score < outputOptions.minSupport) {
        reasons.push('unsupported_claims');
        decision = worst(decision, policy.onUnsupported);
      }
      if (grounding.checked && grounding.contradicted) reasons.push('contradicted_claims');
    }
    const event = decide('output', run, {
      decision,
      reasons,
      degraded,
      metrics: {
        chars: restored.length,
        leaks: leaks.reduce((acc, l) => ({ ...acc, [l.type]: (acc[l.type] || 0) + 1 }), {}),
        moderation: moderation && { unsafe: moderation.unsafe, categories: moderation.categories },
        groundingScore: grounding.checked ? grounding.score : null,
        claims: grounding.checked ? grounding.claims : null,
        unsupportedClaims: grounding.checked ? grounding.unsupported.length : null,
        contradictedClaims: grounding.checked ? grounding.contradicted : null
      }
    });
    return {
      decision,
      text: decision === 'block' ? null : finalText,
      reasons,
      degraded,
      groundingScore: grounding.checked ? grounding.score : null,
      /** Sentences of the reply the sources do not support (kept out of events). */
      unsupported: grounding.checked ? grounding.unsupported : [],
      leaks: leaks.map(({ type, start, end }) => ({ type, start, end })),
      moderation,
      event
    };
  }

  /* ---- beforeAction ---------------------------------------------------------- */

  function beforeAction(action, run, context = {}) {
    const name = action && typeof action.name === 'string' ? action.name : 'action';
    if (run.requiresConfirmation && context.humanConfirmed !== true) {
      decide('beforeAction', run, { decision: 'block', reasons: ['confirmation_required'], degraded: [], metrics: { action: name, suspicions: run.suspicions } });
      return { decision: 'block', reason: 'confirmation_required', needsConfirmation: true };
    }
    decide('beforeAction', run, {
      decision: 'allow', reasons: run.requiresConfirmation ? ['human_confirmed'] : [], degraded: [], metrics: { action: name }
    });
    return { decision: 'allow', needsConfirmation: false };
  }

  return {
    newRun,
    input,
    toolResult,
    output,
    // async-shaped like the others, so the four compose the same way
    beforeAction: async (action, run, context) => beforeAction(action, run, context),
    exportRun,
    restoreRun,
    /** Listen to every event, as `onEvent` does; returns the function that stops listening. */
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe: a function is expected.');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    policy
  };
}

module.exports = { createGuards, DECISIONS, FAIL_CLOSED, FAIL_OPEN, WITHHELD };
