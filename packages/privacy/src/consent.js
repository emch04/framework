/**
 * Consent before anything leaves for an AI provider or the web.
 *
 * App stores, and the law in many places, ask that a person be told — and say
 * yes — BEFORE their questions, files, voice or records reach a third-party AI.
 * The rules below are what that takes once it meets real use:
 *
 * SILENCE IS NEVER CONSENT. No decision reads as "to ask", never as granted.
 *
 * A YES COVERS THE TEXT THAT WAS SHOWN. Each scope carries the version of its
 * text; change the text in substance, raise the version, and everyone who said
 * yes to the old one is asked again. A refusal stays a refusal whatever the
 * version: someone who said no is not pestered, they can come back themselves.
 *
 * THE SERVER STAMPS THE VERSION. A client says which text it showed; a version
 * above the current one is refused — otherwise a client could say "1000" once
 * and cover every future text in advance.
 *
 * NEVER DECIDED IS NOT REFUSED. Refusals and withdrawals are written too, so a
 * withdrawal made on one device is seen on the others.
 *
 * SCOPES ARE SEPARATE. Consent to the assistant is not consent to web search or
 * to a live voice call; a scope may require another (`requires`), and the guard
 * checks the whole chain.
 *
 * No wording lives here. States and refusals are codes; the words come from
 * your catalogue (see consentCopyKeys).
 */

const GRANTED = 'granted';
const REFUSED = 'refused';
const REQUIRED = 'required';

/** Machine-readable refusals from the guard and from grant/revoke. */
const CONSENT_CODES = Object.freeze({
  REQUIRED: 'CONSENT_REQUIRED',
  REFUSED: 'CONSENT_REFUSED',
  UNKNOWN_SCOPE: 'CONSENT_UNKNOWN_SCOPE',
  INVALID_VERSION: 'CONSENT_INVALID_VERSION',
  INVALID_SUBJECT: 'CONSENT_INVALID_SUBJECT'
});

const MAX_VERSION = 1000;

class ConsentError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'ConsentError';
    this.code = code;
    this.statusCode = detail.statusCode || (code === CONSENT_CODES.REQUIRED || code === CONSENT_CODES.REFUSED ? 403 : 400);
    if (detail.scope) this.scope = detail.scope;
  }
}

const isVersion = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_VERSION;

/**
 * A decision, or null for anything that does not look like one.
 * Shape on the wire: { granted: boolean, version: integer >= 1, decidedAt: ISO date }.
 */
function readDecision(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { granted, version, decidedAt } = raw;
  if (typeof granted !== 'boolean') return null;
  if (!isVersion(version)) return null;
  const at = decidedAt instanceof Date ? decidedAt.getTime() : Date.parse(String(decidedAt));
  if (!Number.isFinite(at)) return null;
  return { granted, version, decidedAt: new Date(at).toISOString() };
}

/**
 * What a decision is worth today.
 * @returns {'granted' | 'refused' | 'required'}
 */
function consentState(decision, currentVersion) {
  if (!decision || typeof decision.granted !== 'boolean') return REQUIRED;
  if (!decision.granted) return REFUSED;
  if (!Number.isInteger(decision.version)) return REQUIRED;
  return decision.version >= currentVersion ? GRANTED : REQUIRED;
}

/**
 * The copy kept on a device against the account's.
 *
 * - The most RECENT decision wins: a withdrawal made on another device counts
 *   here, and a withdrawal made here offline is not undone, once the network is
 *   back, by the older yes the server still holds.
 * - A local copy newer than the server's (or alone) must be PUSHED to it.
 * - The server unreachable, or too old to know the route: the local copy holds,
 *   nothing is pushed.
 *
 * @param {object|null} local
 * @param {object|null|'unavailable'} remote
 * @returns {{ kept: object|null, push: boolean }}
 */
function mergeDecisions(local, remote) {
  if (remote === 'unavailable') return { kept: local || null, push: false };
  if (!local) return { kept: remote || null, push: false };
  if (!remote) return { kept: local, push: true };
  const localIsNewer = Date.parse(local.decidedAt) > Date.parse(remote.decidedAt);
  return localIsNewer ? { kept: local, push: true } : { kept: remote, push: false };
}

/** A new decision, dated now, carrying the version of the text shown. */
function newDecision(granted, version, now = new Date()) {
  if (typeof granted !== 'boolean') throw new TypeError('newDecision requires a boolean.');
  if (!isVersion(version)) throw new ConsentError(CONSENT_CODES.INVALID_VERSION);
  return { granted, version, decidedAt: new Date(now).toISOString() };
}

/** A request body, validated: { granted, version } or null when unacceptable. */
function readConsentInput(body) {
  const granted = body && body.granted;
  const version = body && body.version;
  if (typeof granted !== 'boolean') return null;
  if (!isVersion(version)) return null;
  return { granted, version };
}

/**
 * Which set of words to show. A pupil is often a minor and is spoken to
 * simply; which roles that covers is the product's call.
 */
function consentAudience(role, { simple = [] } = {}) {
  return simple.includes(role) ? 'simple' : 'standard';
}

const COPY_SLOTS = ['title', 'lead', 'details', 'refuseNote', 'refusedStatus'];
const SHARED_SLOTS = ['eyebrow', 'accept', 'refuse', 'keepDisabled', 'saveError', 'privacyLink'];

/**
 * The catalogue keys a consent dialog draws its words from — never the words.
 * `prefix.scope.audience.slot` for what depends on who reads, `prefix.slot`
 * for the buttons shared by every scope.
 */
function consentCopyKeys(scope, audience = 'standard', { prefix = 'consent' } = {}) {
  const keys = {};
  for (const slot of COPY_SLOTS) keys[slot] = `${prefix}.${scope}.${audience}.${slot}`;
  for (const slot of SHARED_SLOTS) keys[slot] = `${prefix}.${slot}`;
  return keys;
}

/**
 * The two buttons of the dialog. After a refusal the second one closes the
 * dialog ("keep it off") instead of writing the same refusal again.
 */
function consentDialogActions(state) {
  return { primary: 'accept', secondary: state === REFUSED ? 'keepDisabled' : 'refuse' };
}

function normalizeScopes(scopes) {
  const entries = Object.entries(scopes || {});
  if (!entries.length) throw new Error('createConsent requires at least one scope.');
  const out = new Map();
  for (const [name, definition] of entries) {
    if (!definition || !isVersion(definition.version)) {
      throw new Error(`createConsent: scope "${name}" needs an integer version between 1 and ${MAX_VERSION}.`);
    }
    out.set(name, { version: definition.version, requires: Array.isArray(definition.requires) ? [...definition.requires] : [] });
  }
  for (const [name, definition] of out) {
    for (const required of definition.requires) {
      if (!out.has(required)) throw new Error(`createConsent: scope "${name}" requires the unknown scope "${required}".`);
    }
  }
  /* A cycle would make every guard loop or pass by accident. */
  const visiting = new Set();
  const visit = (name, path) => {
    if (visiting.has(name)) throw new Error(`createConsent: scopes require each other (${[...path, name].join(' -> ')}).`);
    visiting.add(name);
    for (const required of out.get(name).requires) visit(required, [...path, name]);
    visiting.delete(name);
  };
  for (const name of out.keys()) visit(name, []);
  return out;
}

function subjectKey(subject) {
  if (subject === null || subject === undefined || String(subject) === '') {
    throw new ConsentError(CONSENT_CODES.INVALID_SUBJECT);
  }
  return String(subject);
}

/**
 * @param {object} options
 * @param {object} options.store   { get(subject, scope), put(record), list(subject), remove(subject, scope?) }
 * @param {Record<string, {version: number, requires?: string[]}>} options.scopes
 * @param {Function} [options.now] () => Date
 * @param {Function} [options.onChange] ({ subject, scope, granted, version }) => void — never awaited on the read path.
 */
function createConsent(options = {}) {
  const store = options.store;
  for (const method of ['get', 'put', 'list', 'remove']) {
    if (!store || typeof store[method] !== 'function') {
      throw new Error(`Astratra privacy requires options.store.${method}().`);
    }
  }
  const scopes = normalizeScopes(options.scopes);
  const now = options.now || (() => new Date());
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;

  function definitionOf(scope) {
    const definition = scopes.get(scope);
    if (!definition) throw new ConsentError(CONSENT_CODES.UNKNOWN_SCOPE, { scope });
    return definition;
  }

  function toDecision(record) {
    return record ? readDecision(record) : null;
  }

  /** What the subject decided for one scope, as the client reads it — or null. */
  async function decision(subject, scope) {
    definitionOf(scope);
    return toDecision(await store.get(subjectKey(subject), scope));
  }

  /** The state of one scope, on its own (prerequisites not included). */
  async function check(subject, scope) {
    const { version } = definitionOf(scope);
    const found = await decision(subject, scope);
    return {
      scope,
      state: consentState(found, version),
      currentVersion: version,
      decidedVersion: found ? found.version : null,
      decidedAt: found ? found.decidedAt : null
    };
  }

  async function record(subject, scope, granted, shownVersion) {
    const { version: current } = definitionOf(scope);
    const key = subjectKey(subject);
    const version = shownVersion === undefined ? current : shownVersion;
    /* The client may have shown an older text (an app not yet updated): the
       decision is kept with THAT version, and a yes on it will be asked again.
       A version from the future is a client lying, or a bug. */
    if (!isVersion(version) || version > current) {
      throw new ConsentError(CONSENT_CODES.INVALID_VERSION, { scope });
    }
    const row = { subject: key, scope, granted, version, decidedAt: new Date(now()).toISOString() };
    await store.put(row);
    if (onChange) {
      try { onChange({ subject: key, scope, granted, version }); } catch (_error) { /* a listener never undoes a decision */ }
    }
    return readDecision(row);
  }

  /** Yes. `version` is the text shown; defaults to the current one. */
  const grant = (subject, scope, { version } = {}) => record(subject, scope, true, version);

  /** No, or a withdrawal. Stamped with the current version: a no is a no. */
  const revoke = (subject, scope) => record(subject, scope, false, definitionOf(scope).version);

  /** A scope and every scope it requires, prerequisites first. */
  function chainOf(scope, seen = new Set()) {
    if (seen.has(scope)) return [];
    seen.add(scope);
    const { requires } = definitionOf(scope);
    return [...requires.flatMap((required) => chainOf(required, seen)), scope];
  }

  /**
   * May this action run? Checks the scope(s) and their prerequisites.
   * Never throws for a missing consent: returns a code the caller acts on.
   * @returns {Promise<{ allowed: true } | { allowed: false, code: string, scope: string, state: string }>}
   */
  async function guard(subject, scopeOrScopes) {
    const wanted = Array.isArray(scopeOrScopes) ? scopeOrScopes : [scopeOrScopes];
    const seen = new Set();
    const chain = wanted.flatMap((scope) => chainOf(scope, seen));
    for (const scope of chain) {
      const { state } = await check(subject, scope);
      if (state !== GRANTED) {
        return { allowed: false, code: state === REFUSED ? CONSENT_CODES.REFUSED : CONSENT_CODES.REQUIRED, scope, state };
      }
    }
    return { allowed: true };
  }

  /** Same, but throws a ConsentError (403) — for code that would rather not branch. */
  async function assert(subject, scopeOrScopes) {
    const verdict = await guard(subject, scopeOrScopes);
    if (!verdict.allowed) throw new ConsentError(verdict.code, { scope: verdict.scope });
  }

  /**
   * Wrap an action so it never runs without consent.
   * `subjectOf(...args)` names whose consent it takes.
   * Resolves `{ blocked: true, code, scope }` instead of calling `action`.
   */
  function guarded(scopeOrScopes, subjectOf, action) {
    if (typeof subjectOf !== 'function' || typeof action !== 'function') {
      throw new Error('guarded(scope, subjectOf, action) requires two functions.');
    }
    return async (...args) => {
      const verdict = await guard(subjectOf(...args), scopeOrScopes);
      if (!verdict.allowed) return { blocked: true, code: verdict.code, scope: verdict.scope };
      return action(...args);
    };
  }

  /** Every scope's state for a subject — what a settings screen lists. */
  async function overview(subject) {
    const key = subjectKey(subject);
    const rows = await store.list(key);
    const byScope = new Map((rows || []).map((row) => [row.scope, readDecision(row)]));
    return [...scopes.entries()].map(([scope, { version }]) => {
      const found = byScope.get(scope) || null;
      return { scope, state: consentState(found, version), currentVersion: version, decidedVersion: found ? found.version : null, decidedAt: found ? found.decidedAt : null };
    });
  }

  /** The subject's decisions, for a data export. */
  async function exportFor(subject) {
    const rows = await store.list(subjectKey(subject));
    return (rows || []).map((row) => ({ scope: row.scope, ...readDecision(row) }));
  }

  /** Forget the subject's decisions — part of an account erasure. */
  async function forget(subject, scope) {
    if (scope !== undefined) definitionOf(scope);
    return store.remove(subjectKey(subject), scope);
  }

  return {
    decision, check, grant, revoke, guard, assert, guarded, overview, exportFor, forget,
    scopes: [...scopes.keys()],
    versionOf: (scope) => definitionOf(scope).version
  };
}

module.exports = {
  createConsent,
  ConsentError,
  CONSENT_CODES,
  CONSENT_GRANTED: GRANTED,
  CONSENT_REFUSED: REFUSED,
  CONSENT_REQUIRED: REQUIRED,
  CONSENT_MAX_VERSION: MAX_VERSION,
  readDecision,
  consentState,
  mergeDecisions,
  newDecision,
  readConsentInput,
  consentAudience,
  consentCopyKeys,
  consentDialogActions
};
