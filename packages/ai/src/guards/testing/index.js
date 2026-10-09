'use strict';
const { createGuards } = require('../createGuards');

/**
 * Light stand-ins for tests: no model, no network, no service.
 *
 *   createFakeModels(rules)   a client shaped like @astratra/models' (entities, injection,
 *                             moderation, nli) answering from simple rules you can override
 *   createMockGuards(options) the real guards over that fake client, plus an event recorder
 *   createEventRecorder()     collects the events the guards emit
 *
 * The fakes are keyword rules, not detectors: they exist so the code around the guards
 * (an agent loop, a route) can be tested for what it does with a decision.
 */

const INJECTION_WORDS = /ignore (all )?(the )?(previous|prior|above) (instructions|rules)|ignore(z)? (toutes )?(les )?(instructions|consignes) pr[ée]c[ée]dentes|system prompt|invite syst[èe]me/i;
const UNSAFE_WORDS = /\b(kill you|je vais te tuer|suicide|suicider)\b/i;

const ok = (data) => ({ ok: true, ...data });
const fail = (endpoint, code = 'unavailable') => ({ ok: false, code, endpoint, retryable: true });

/**
 * @param {object} [rules] each optional:
 *   names: string[]            texts `entities` finds (default: none)
 *   injectionScore(text)       0..1 (default: 0.97 on a classic override phrase, else 0.01)
 *   moderate(text)             { unsafe, categories } (default: flagged on a few violent words)
 *   entails(premise, claim)    boolean (default: every word of the claim appears in the premise)
 *   down: string[]             endpoints that answer a failure, e.g. ['injection']
 */
function createFakeModels(rules = {}) {
  const down = new Set(rules.down || []);
  const calls = [];
  const score = rules.injectionScore || ((text) => (INJECTION_WORDS.test(text) ? 0.97 : 0.01));
  const moderate = rules.moderate || ((text) => (UNSAFE_WORDS.test(text) ? { unsafe: 0.95, categories: { violence: 0.9 } } : { unsafe: 0.01, categories: {} }));
  const words = (t) => new Set(String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const entails = rules.entails || ((premise, claim) => {
    const have = words(premise);
    return [...words(claim)].every((w) => have.has(w));
  });
  const wrap = (endpoint, run) => async (...args) => {
    calls.push({ endpoint, size: Array.isArray(args[0]) ? args[0].length : 1 });
    if (down.has(endpoint)) return fail(endpoint);
    return run(...args);
  };
  const list = (input) => (typeof input === 'string' ? [input] : input);
  return {
    calls,
    setDown: (endpoint, isDown = true) => (isDown ? down.add(endpoint) : down.delete(endpoint)),
    entities: wrap('entities', (text) => ok({
      entities: (rules.names || []).flatMap((name) => {
        const start = text.indexOf(name);
        return start < 0 ? [] : [{ text: name, label: 'person', start, end: start + name.length, score: 0.95 }];
      }),
      model: 'fake-entities'
    })),
    injection: wrap('injection', (input) => {
      const results = list(input).map((text) => { const s = score(text); return { score: s, verdict: s >= 0.5 ? 'injection' : 'safe' }; });
      return ok({ results, threshold: 0.5, model: 'fake-injection' });
    }),
    moderation: wrap('moderation', (input) => {
      const results = list(input).map((text) => {
        const r = moderate(text);
        return { flagged: r.unsafe >= 0.5, unsafe: r.unsafe, categories: r.categories, flaggedCategories: r.unsafe >= 0.5 ? Object.keys(r.categories) : [] };
      });
      return ok({ results, model: 'fake-moderation' });
    }),
    nli: wrap('nli', (pairs) => ok({
      results: pairs.map((p) => (entails(p.premise, p.hypothesis)
        ? { entailment: 0.95, neutral: 0.04, contradiction: 0.01 }
        : { entailment: 0.05, neutral: 0.9, contradiction: 0.05 })),
      model: 'fake-nli'
    }))
  };
}

function createEventRecorder() {
  const events = [];
  const record = (event) => { events.push(event); };
  record.events = events;
  record.last = () => events[events.length - 1];
  record.decisions = (guard) => events.filter((e) => !guard || e.guard === guard).map((e) => e.decision);
  return record;
}

/**
 * The real guards over a fake models client. Returns `{ guards, models, events }`.
 * @param {object} [options] { rules (see createFakeModels), models, ...createGuards options }
 */
function createMockGuards(options = {}) {
  const { rules, models, ...rest } = options;
  const fake = models || createFakeModels(rules);
  const events = createEventRecorder();
  const guards = createGuards({
    onEvent: (event) => { events(event); if (rest.onEvent) rest.onEvent(event); },
    ...rest,
    models: fake,
    verifySources: rest.verifySources || simpleVerifySources
  });
  return { guards, models: fake, events: events.events, recorder: events };
}

/* The same contract as verifySources of @astratra/rag, minimal: one claim per sentence,
   checked against every source. Keeps the testing entry point free of other packages. */
async function simpleVerifySources(answer, sources, { nli }) {
  const claims = String(answer).split(/(?<=[.!?])\s+|\n+/).map((c) => c.trim()).filter((c) => c && !/\?$/.test(c));
  const claimsOut = [];
  for (const claim of claims) {
    const pairs = sources.map((premise) => ({ premise, hypothesis: claim }));
    const scores = pairs.length ? await nli(pairs) : [];
    const best = Math.max(0, ...scores.map((s) => s.entailment));
    claimsOut.push({ category: best >= 0.5 ? 'SUPPORTED' : 'UNSUPPORTED', claim, source: null });
  }
  return { code: 'OK', claims: claimsOut, flags: [] };
}

module.exports = { createFakeModels, createMockGuards, createEventRecorder };
