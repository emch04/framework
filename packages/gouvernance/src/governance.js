'use strict';
const crypto = require('node:crypto');
const { createCalendarBudget, createMemoryToolBudgetStore } = require('@astratra/conscience/governor');
const { GouvernanceError } = require('./errors');
const { digestOf, keyedDigest, sameValue, randomSalt, stableStringify, toJsonValue } = require('./stable');
const { PROPOSAL_SCHEMA, RESULT_SCHEMA, NAME, normalizeActions, isPlainObject } = require('./contract');
const { normalizeRules, decideLevel, rank } = require('./levels');
const { createTrust, verifyValidation, challengeFor, withoutDigest } = require('./validation');

/*
 * Le cycle d'une action de l'IA sur les données :
 * proposer → aperçu exact → niveau d'autonomie → (validation humaine signée) →
 * revérification au moment d'écrire → exécution tout ou rien → audit → (annulation).
 * Aucun modèle n'est consulté : la même proposition et les mêmes règles donnent toujours la
 * même décision. L'IA ne peut ni valider, ni annuler, ni lever un arrêt d'urgence.
 */

const STATUSES = Object.freeze(['ready', 'awaiting_validation', 'executing', 'executed', 'declined', 'expired', 'refused', 'stale', 'failed', 'undoing', 'undone']);
const HOUR = 3600_000;

const fail = (code, message) => { throw new GouvernanceError(code, message); };
const actorOf = (actor) => (isPlainObject(actor) && typeof actor.kind === 'string' && typeof actor.id === 'string' && actor.id ? { kind: actor.kind, id: actor.id } : null);
const masked = (salt, value) => ({ $masked: keyedDigest(salt, value) });

function createDataGovernance(options = {}) {
  const { governor, auditStore, store, connectors } = options;
  if (!governor || typeof governor.isHalted !== 'function') fail('governor_missing', 'Le gouverneur de @astratra/conscience est obligatoire (arrêt d\'urgence).');
  if (!auditStore || typeof auditStore.appendAudit !== 'function') fail('audit_unavailable', 'Le magasin du gouverneur est obligatoire (journal d\'audit).');
  for (const method of ['put', 'get', 'findByIdempotencyKey', 'transition', 'list']) {
    if (!store || typeof store[method] !== 'function') fail('store_invalid', `Le magasin des propositions n'a pas ${method}().`);
  }
  if (!isPlainObject(connectors) || !Object.keys(connectors).length) fail('connectors_missing', 'Déclarer au moins un connecteur.');
  for (const [name, connector] of Object.entries(connectors)) {
    if (!NAME.test(name) || !connector || typeof connector.preview !== 'function' || typeof connector.execute !== 'function' || !connector.resources) fail('connectors_missing', `Connecteur invalide : ${name}.`);
  }
  const localRules = normalizeRules(options.rules, 'local');
  const trust = options.trust ? createTrust(options.trust) : null;
  const environment = options.environment ?? 'production';
  if (!NAME.test(environment)) fail('invalid_options', 'environment invalide.');
  const proposalTtlMs = options.proposalTtlMs ?? 12 * HOUR;
  const undoWindowMs = options.undoWindowMs ?? 24 * HOUR;
  const now = options.now ?? Date.now;
  const newId = options.idFactory ?? (() => crypto.randomUUID());
  const iso = (at = now()) => new Date(at).toISOString();
  const quotaTimeZone = options.quotas?.timeZone ?? 'UTC';
  const quotaBudget = createCalendarBudget({ period: 'day', timeZone: quotaTimeZone, store: options.quotas?.store ?? createMemoryToolBudgetStore(), now });
  const freePerDay = options.quotas?.perDay ?? null;
  if (freePerDay !== null && (!Number.isSafeInteger(freePerDay) || freePerDay < 0)) fail('invalid_options', 'quotas.perDay doit être un entier positif.');

  /* ───────── Règles distantes : on ne peut que resserrer, jamais assouplir la politique locale ───────── */
  const remoteCache = new Map();
  async function currentRules(organisationId) {
    if (typeof options.remoteRules !== 'function') return { rules: localRules, remote: 'none', floor: null };
    let read = null;
    try {
      const answer = await options.remoteRules({ organisationId, environment });
      read = { version: answer?.version ?? null, rules: normalizeRules(answer?.rules ?? [], 'remote') };
      remoteCache.set(organisationId, read);
    } catch (_error) {
      read = remoteCache.get(organisationId) ?? null;
      if (read) return { rules: [...localRules, ...read.rules], remote: 'last_known', version: read.version, floor: null };
      /* Jamais lues : tout ce qui écrit attend une validation. */
      return { rules: localRules, remote: 'unavailable', floor: 'validation' };
    }
    return { rules: [...localRules, ...read.rules], remote: 'current', version: read.version, floor: null };
  }

  async function audit(entry) {
    const full = { id: newId(), at: iso(), source: 'gouvernance', organisationId: null, proposalId: null, reasons: [], actor: null, ...entry };
    try {
      await auditStore.appendAudit(full);
    } catch (error) {
      throw new GouvernanceError('audit_unavailable', `Le journal d'audit ne s'écrit pas : rien n'est fait (${error.message}).`);
    }
    try { await options.onEvent?.({ type: 'gouvernance', ...full }); } catch (_error) { /* Un observateur ne change jamais une décision. */ }
    return full;
  }

  async function halted(organisationId) {
    try { return await governor.isHalted(organisationId); } catch (_error) { return true; } // Gouverneur illisible : on s'arrête.
  }

  /* ───────── Aperçu ───────── */

  function computeAfter(set, before) {
    const after = {};
    for (const [column, change] of Object.entries(set)) {
      if ('value' in change) { after[column] = change.value; continue; }
      const current = before[column];
      const number = typeof current === 'number' ? current : typeof current === 'string' && current.trim() !== '' ? Number(current) : NaN;
      if (!Number.isFinite(number)) fail('invalid_action', `La colonne ${column} n'est pas un nombre : « increment » et « multiply » impossibles.`);
      let value = 'increment' in change ? number + change.increment : number * change.multiply;
      if (change.round !== null) value = Math.round(value * 10 ** change.round) / 10 ** change.round;
      if (!Number.isFinite(value)) fail('invalid_action', `Résultat non fini pour ${column}.`);
      after[column] = value;
    }
    return after;
  }

  const pick = (row, columns) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
  const showRow = (resource, salt, row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, resource.sensitive.includes(column) ? masked(salt, value) : value]));
  const amountOf = (resource, before, after) => {
    if (!resource.amount) return 0;
    const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
    return Math.abs(n(after?.[resource.amount]) - n(before?.[resource.amount]));
  };

  async function buildPreview(actions, salt) {
    const connector = connectors[actions[0].connector];
    const rows = [];
    const local = [];
    const seen = new Set();
    for (const [index, action] of actions.entries()) {
      const resource = connector.resources[action.resource];
      const found = await connector.preview(action, { limit: resource.maxRows + 1 });
      const lines = found.rows.map((row) => toJsonValue(row));
      const localRows = [];
      if (action.op === 'insert') {
        if (lines.length) fail('row_exists', `${resource.name} : une ligne existe déjà avec cette clé.`);
        localRows.push({ key: pick(action.values, resource.key), before: null, after: { ...action.values } });
      } else {
        if (!lines.length) fail('no_rows', `${resource.name} : aucune ligne ne correspond.`);
        if (lines.length > resource.maxRows) fail('too_many_rows', `${resource.name} : plus de ${resource.maxRows} lignes.`);
        for (const row of lines) {
          const key = pick(row, resource.key);
          localRows.push({ key, before: row, after: action.op === 'update' ? { ...row, ...computeAfter(action.set, row) } : null });
        }
      }
      for (const line of localRows) {
        const mark = `${resource.name}\u0000${stableStringify(line.key)}`;
        if (seen.has(mark)) fail('overlapping_actions', 'Deux actions touchent la même ligne : les regrouper.');
        seen.add(mark);
        const touched = action.op === 'update' ? Object.keys(action.set) : action.op === 'insert' ? Object.keys(action.values) : resource.readable.filter((c) => !resource.key.includes(c));
        rows.push({
          action: index, resource: resource.name, op: action.op, key: line.key,
          before: line.before ? showRow(resource, salt, pick(line.before, touched)) : null,
          after: line.after ? showRow(resource, salt, pick(line.after, touched)) : null,
          version: line.before ? keyedDigest(salt, line.before) : null
        });
      }
      local.push({ rows: localRows });
    }
    return { rows, local };
  }

  function classify(actions, preview, local) {
    const connector = connectors[actions[0].connector];
    const groups = new Map();
    for (const [index, action] of actions.entries()) {
      const resource = connector.resources[action.resource];
      const group = groups.get(resource.name) ?? { resource: resource.name, ops: [], tags: [...resource.tags], rows: 0, amount: 0 };
      if (!group.ops.includes(action.op)) group.ops.push(action.op);
      for (const line of local[index].rows) { group.rows += 1; group.amount += amountOf(resource, line.before, line.after); }
      groups.set(resource.name, group);
    }
    const list = [...groups.values()].map((g) => ({ ...g, ops: g.ops.sort(), amount: Math.round(g.amount * 1e6) / 1e6 }));
    return {
      groups: list,
      totals: { rows: preview.rows.length, actions: actions.length, resources: list.length, amount: list.reduce((sum, g) => sum + g.amount, 0) }
    };
  }

  async function levelFor(record, at) {
    const proposal = record.proposal;
    const { rules, remote, floor, version } = await currentRules(proposal.organisationId);
    const decided = decideLevel({ groups: proposal.classification.groups, agent: proposal.agent.id, at, rules });
    const reasons = [];
    let level = decided.level;
    if (floor) {
      reasons.push('remote_rules_unavailable');
      if (rank(level) < rank(floor)) level = floor;
    }
    /* Une suppression ne se défait pas : jamais « libre avec avis ». */
    if (level === 'free_with_notice' && proposal.actions.some((a) => a.op === 'delete')) { level = 'validation'; reasons.push('not_undoable'); }
    return { ...decided, level, reasons, remote, rulesVersion: version ?? null };
  }

  async function quotaAllows({ organisationId, agentId, quotaRules, at }) {
    const scopes = [];
    if (freePerDay !== null) scopes.push({ scope: `free:${organisationId}:${agentId}`, limit: freePerDay });
    for (const rule of quotaRules) scopes.push({ scope: `free:${organisationId}:${agentId}:${rule.origin}:${rule.id}`, limit: rule.quota.perDay });
    for (const s of scopes) {
      const check = await quotaBudget.check({ scope: s.scope, limit: s.limit, estimate: 1, at });
      if (!check.allowed) return { allowed: false, scopes };
    }
    return { allowed: true, scopes };
  }

  /* ───────── Proposer ───────── */

  function checkInput(input) {
    if (!isPlainObject(input)) fail('invalid_proposal', 'La proposition doit être un objet.');
    const { organisationId, agent, requestedBy, intent } = input;
    if (typeof organisationId !== 'string' || !NAME.test(organisationId)) fail('invalid_proposal', 'organisationId invalide.');
    if (!isPlainObject(agent) || typeof agent.id !== 'string' || !NAME.test(agent.id)) fail('invalid_proposal', 'agent.id invalide.');
    for (const field of ['model', 'instructions']) if (agent[field] !== undefined && (typeof agent[field] !== 'string' || agent[field].length > 200)) fail('invalid_proposal', `agent.${field} invalide.`);
    if (requestedBy !== undefined && requestedBy !== null && !actorOf(requestedBy)) fail('invalid_proposal', 'requestedBy : { kind, id }.');
    if (!isPlainObject(intent) || typeof intent.code !== 'string' || !NAME.test(intent.code)) fail('invalid_proposal', 'intent.code : un code court.');
    if (intent.confidence !== undefined && (typeof intent.confidence !== 'number' || intent.confidence < 0 || intent.confidence > 1)) fail('invalid_proposal', 'intent.confidence de 0 à 1.');
    if (input.explanation !== undefined && (typeof input.explanation !== 'string' || input.explanation.length > 4000)) fail('invalid_proposal', 'explanation : un texte de 4 000 caractères au plus.');
    if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !NAME.test(input.idempotencyKey))) fail('invalid_proposal', 'idempotencyKey invalide.');
  }

  /**
   * L'IA propose. Rend { status, proposal, explanation, reasons, result? } : `proposal` est la
   * forme à envoyer au service de validation (valeurs sensibles masquées, empreinte comprise).
   */
  async function propose(input) {
    checkInput(input);
    const { organisationId } = input;
    if (input.idempotencyKey) {
      const existing = await store.findByIdempotencyKey(organisationId, input.idempotencyKey);
      if (existing) return view(existing);
    }
    const agent = { id: input.agent.id, model: input.agent.model ?? null, instructions: input.agent.instructions ?? null };
    if (await halted(organisationId)) {
      await audit({ action: 'data_proposal', organisationId, decision: 'refused', reasons: ['governor_halted'], actor: { kind: 'model', id: agent.id } });
      return { status: 'refused', proposal: null, explanation: null, reasons: ['governor_halted'] };
    }
    const actions = normalizeActions(input.actions, connectors);
    if (new Set(actions.map((a) => a.connector)).size > 1) fail('mixed_connectors', 'Une proposition ne touche qu\'une base : tout ou rien n\'est possible qu\'ainsi.');
    const salt = randomSalt();
    const preview = await buildPreview(actions, salt);
    const { groups, totals } = classify(actions, preview, preview.local);
    const at = now();
    const id = input.id ?? newId();
    if (typeof id !== 'string' || !NAME.test(id)) fail('invalid_proposal', 'id invalide.');
    const body = {
      schema: PROPOSAL_SCHEMA, id, organisationId, environment,
      createdAt: iso(at), expiresAt: iso(at + proposalTtlMs),
      agent, requestedBy: actorOf(input.requestedBy), intent: { code: input.intent.code, confidence: input.intent.confidence ?? null },
      idempotencyKey: input.idempotencyKey ?? null,
      actions,
      preview: { rows: preview.rows, counts: { rows: totals.rows, actions: totals.actions, resources: totals.resources }, amount: totals.amount },
      classification: { groups, level: null, approvals: null, rules: [] }
    };
    const record = { proposal: body };
    const decided = await levelFor(record, at);
    const reasons = [...decided.reasons];
    let level = decided.level;
    let quota = null;
    if (level === 'free' || level === 'free_with_notice') {
      quota = await quotaAllows({ organisationId, agentId: agent.id, quotaRules: decided.quotaRules, at });
      if (!quota.allowed) { level = 'validation'; reasons.push('quota_exceeded'); }
    }
    body.classification = { groups, level, approvals: decided.approvals, rules: decided.matched.map((m) => ({ id: m.id, origin: m.origin, level: m.level })) };
    const proposal = { ...body, digest: digestOf(body) };
    const status = level === 'forbidden' ? 'refused' : level === 'validation' ? 'awaiting_validation' : 'ready';
    if (level === 'forbidden') reasons.push('forbidden');
    await audit({
      action: 'data_proposal', organisationId, proposalId: id, decision: status, reasons, level, digest: proposal.digest,
      actor: { kind: 'model', id: agent.id }, counts: proposal.preview.counts, rulesVersion: decided.rulesVersion
    });
    const stored = {
      organisationId, id, digest: proposal.digest, status, level, createdAt: proposal.createdAt, expiresAt: proposal.expiresAt, updatedAt: proposal.createdAt,
      idempotencyKey: proposal.idempotencyKey, proposal, explanation: input.explanation ?? null,
      local: { salt, actions: preview.local, quotaScopes: quota?.scopes.map((s) => s.scope) ?? [] },
      validation: null, result: null, undo: null, reasons
    };
    const { record: saved } = await store.put(stored);
    if (saved.status !== 'ready') return view(saved);
    const outcome = await runExecution(saved, { from: ['ready'], actor: { kind: 'model', id: agent.id }, validation: null });
    return view(outcome.record ?? saved, outcome);
  }

  /* ───────── Exécuter ───────── */

  /** Compare les lignes trouvées au moment d'écrire avec celles qu'on attend. */
  function compareFor(record) {
    const { salt } = record.local;
    return (step, found) => {
      const resource = connectors[record.proposal.actions[0].connector].resources[step.resource];
      const keyOf = (row) => stableStringify(pick(row, resource.key));
      if (found.length !== step.expect.length) return { action: step.action, reason: found.length > step.expect.length ? 'appeared' : 'missing' };
      const byKey = new Map(found.map((row) => [keyOf(row), toJsonValue(row)]));
      for (const expected of step.expect) {
        const row = byKey.get(stableStringify(expected.key));
        if (!row) return { action: step.action, reason: 'missing' };
        if (expected.version !== undefined && keyedDigest(salt, row) !== expected.version) return { action: step.action, reason: 'changed' };
        if (expected.values && !Object.entries(expected.values).every(([column, value]) => sameValue(row[column], value))) return { action: step.action, reason: 'changed' };
      }
      return null;
    };
  }

  function executionPlan(record) {
    const { proposal, local } = record;
    const steps = proposal.actions.map((action, index) => {
      const rows = local.actions[index].rows;
      if (action.op === 'insert') {
        return { action: index, resource: action.resource, op: 'insert', select: { keys: rows.map((r) => r.key) }, expect: [], writes: rows.map((r) => ({ kind: 'insert', key: r.key, values: r.after })) };
      }
      return {
        action: index, resource: action.resource, op: action.op, select: { where: action.where },
        /* `before` : la ligne entière lue à l'aperçu, pour un connecteur qui revérifie par un filtre d'égalité (MongoDB sans transaction). */
        expect: rows.map((r) => ({ key: r.key, version: keyedDigest(local.salt, r.before), before: r.before })),
        writes: rows.map((r) => (action.op === 'update'
          ? { kind: 'update', key: r.key, set: pick(r.after, Object.keys(action.set)) }
          : { kind: 'delete', key: r.key }))
      };
    });
    return { steps, compare: compareFor(record) };
  }

  function undoPlan(record) {
    const { proposal, local } = record;
    const steps = proposal.actions.map((action, index) => {
      const rows = local.actions[index].rows;
      if (action.op === 'delete') fail('not_undoable', 'Une suppression ne se défait pas.');
      if (action.op === 'insert') {
        return { action: index, resource: action.resource, op: 'delete', select: { keys: rows.map((r) => r.key) },
          expect: rows.map((r) => ({ key: r.key, values: r.after })), writes: rows.map((r) => ({ kind: 'delete', key: r.key })) };
      }
      const columns = Object.keys(action.set);
      return { action: index, resource: action.resource, op: 'update', select: { keys: rows.map((r) => r.key) },
        expect: rows.map((r) => ({ key: r.key, values: pick(r.after, columns) })),
        writes: rows.map((r) => ({ kind: 'update', key: r.key, set: pick(r.before, columns) })) };
    }).reverse();
    return { steps, compare: compareFor(record) };
  }

  const resultOf = (record, status, extra = {}) => ({
    schema: RESULT_SCHEMA, propositionId: record.id, status, code: extra.code ?? null, rowsAffected: extra.rowsAffected ?? 0, at: iso(),
    detail: extra.detail ?? null
  });

  async function runExecution(record, { from, actor, validation }) {
    const { organisationId, id } = record;
    if (await halted(organisationId)) {
      await audit({ action: 'data_execution', organisationId, proposalId: id, decision: 'refused', reasons: ['governor_halted'], actor });
      return { code: 'governor_halted', record };
    }
    await audit({ action: 'data_execution', organisationId, proposalId: id, decision: 'allowed', level: record.level, digest: record.digest, actor, approvers: validation?.approvers ?? [] });
    const claimed = await store.transition(organisationId, id, { from, to: 'executing', patch: { validation }, at: iso() });
    if (!claimed) return { code: 'replayed', record: await store.get(organisationId, id) };
    const connector = connectors[record.proposal.actions[0].connector];
    let outcome;
    try {
      outcome = await connector.execute(executionPlan(claimed), {
        finalize: async ({ rowsAffected, client }) => {
          const result = resultOf(claimed, 'executed', { rowsAffected });
          const done = await store.transition(organisationId, id, { from: ['executing'], to: 'executed', patch: { result, executedAt: result.at }, at: result.at }, { client });
          if (!done) fail('store_conflict', 'La proposition a changé d\'état pendant l\'exécution.');
        }
      });
    } catch (error) {
      const result = resultOf(claimed, 'failed', { code: 'execution_failed' });
      const after = await store.transition(organisationId, id, { from: ['executing'], to: 'failed', patch: { result }, at: result.at });
      await audit({ action: 'data_outcome', organisationId, proposalId: id, decision: 'failed', reasons: ['execution_failed'], actor });
      try { await options.onError?.(error); } catch (_e) { /* rien */ }
      return { code: 'execution_failed', record: after ?? claimed };
    }
    if (!outcome.ok) {
      const result = resultOf(claimed, 'stale', { code: outcome.code ?? 'stale_data', detail: outcome.detail ?? null });
      const after = await store.transition(organisationId, id, { from: ['executing'], to: 'stale', patch: { result }, at: result.at });
      await audit({ action: 'data_outcome', organisationId, proposalId: id, decision: 'stale', reasons: [result.code], actor, detail: result.detail });
      return { code: result.code, record: after ?? claimed };
    }
    const after = await store.get(organisationId, id);
    for (const scope of claimed.local.quotaScopes ?? []) {
      try { await quotaBudget.record({ scope, amount: 1, id }); } catch (_error) { /* Le compteur ne défait pas une écriture faite. */ }
    }
    await audit({ action: 'data_outcome', organisationId, proposalId: id, decision: 'executed', actor, rowsAffected: outcome.rowsAffected });
    return { code: null, record: after };
  }

  /* ───────── Valider, refuser, annuler ───────── */

  /**
   * Applique une validation signée reçue du service de validation. Rend la vue de la
   * proposition, avec `code` quand elle est refusée (signature, empreinte, date, preuve humaine…).
   */
  async function applyValidation(validation, { organisationId } = {}) {
    if (!trust) fail('trust_missing', 'Sans « trust », aucune validation ne peut être vérifiée.');
    if (typeof organisationId !== 'string' || !organisationId) fail('invalid_proposal', 'organisationId requis.');
    const id = isPlainObject(validation) ? validation.propositionId : null;
    const record = typeof id === 'string' ? await store.get(organisationId, id) : null;
    if (!record) return { status: null, code: 'not_found' };
    const checked = verifyValidation(validation, { trust, proposal: record.proposal, environment, now: now() });
    if (!checked.ok) {
      await audit({ action: 'validation_refused', organisationId, proposalId: record.id, decision: 'refused', reasons: [checked.code], actor: null });
      return view(record, { code: checked.code });
    }
    const signedBy = { keyId: validation.keyId, decision: checked.decision, approvers: checked.approvers, issuedAt: validation.issuedAt, digest: digestOf(validation) };
    const humans = checked.approvers.map((approver) => ({ kind: 'human', id: approver }));
    if (checked.decision === 'undo') return undoRecord(record, { by: humans[0], signedBy });
    if (checked.decision === 'decline') {
      const after = await store.transition(organisationId, record.id, { from: ['awaiting_validation'], to: 'declined', patch: { validation: signedBy }, at: iso() });
      await audit({ action: 'data_decision', organisationId, proposalId: record.id, decision: after ? 'declined' : 'ignored', reasons: after ? [] : ['already_handled'], actor: null });
      return view(after ?? record, after ? {} : { code: 'already_handled' });
    }
    if (record.status !== 'awaiting_validation') return view(record, { code: record.status === 'executed' ? 'replayed' : 'already_handled' });
    if (now() > Date.parse(record.expiresAt)) {
      const after = await store.transition(organisationId, record.id, { from: ['awaiting_validation'], to: 'expired', at: iso() });
      await audit({ action: 'data_decision', organisationId, proposalId: record.id, decision: 'expired', reasons: ['expired'], actor: humans[0] });
      return view(after ?? record, { code: 'expired' });
    }
    /* Les règles relues au moment d'exécuter : « interdit » bloque même validé ; un nombre d'approbations relevé s'applique. */
    const current = await levelFor(record, now());
    if (current.level === 'forbidden') {
      const after = await store.transition(organisationId, record.id, { from: ['awaiting_validation'], to: 'refused', patch: { reasons: ['forbidden'] }, at: iso() });
      await audit({ action: 'data_decision', organisationId, proposalId: record.id, decision: 'refused', reasons: ['forbidden'], actor: humans[0] });
      return view(after ?? record, { code: 'forbidden' });
    }
    const required = Math.max(record.proposal.classification.approvals ?? 1, current.approvals ?? 1);
    if (checked.approvers.length < required) {
      await audit({ action: 'data_decision', organisationId, proposalId: record.id, decision: 'refused', reasons: ['not_enough_approvals'], actor: humans[0] });
      return view(record, { code: 'not_enough_approvals' });
    }
    await audit({ action: 'data_decision', organisationId, proposalId: record.id, decision: 'approved', actor: humans[0], approvers: checked.approvers, keyId: validation.keyId });
    const outcome = await runExecution(record, { from: ['awaiting_validation'], actor: humans[0], validation: signedBy });
    return view(outcome.record ?? record, outcome);
  }

  async function undoRecord(record, { by, signedBy = null }) {
    const { organisationId, id } = record;
    if (!by || by.kind !== 'human') fail('approver_not_human', 'Seul un humain annule une action.');
    if (record.status !== 'executed') return view(record, { code: 'not_executed' });
    if (now() - Date.parse(record.executedAt ?? record.updatedAt) > undoWindowMs) return view(record, { code: 'undo_window_closed' });
    let plan;
    try { plan = undoPlan(record); } catch (error) { if (error.code === 'not_undoable') return view(record, { code: 'not_undoable' }); throw error; }
    /* Pas de contrôle de l'arrêt d'urgence ici : annuler reste permis à l'arrêt, cela ramène à l'état d'avant. */
    await audit({ action: 'data_undo', organisationId, proposalId: id, decision: 'allowed', actor: by });
    const claimed = await store.transition(organisationId, id, { from: ['executed'], to: 'undoing', at: iso() });
    if (!claimed) return view(await store.get(organisationId, id), { code: 'already_handled' });
    const connector = connectors[record.proposal.actions[0].connector];
    let outcome;
    try {
      outcome = await connector.execute(plan, {
        finalize: async ({ rowsAffected, client }) => {
          const undo = { by, at: iso(), rowsAffected, validation: signedBy };
          const done = await store.transition(organisationId, id, { from: ['undoing'], to: 'undone', patch: { undo }, at: undo.at }, { client });
          if (!done) fail('store_conflict', 'La proposition a changé d\'état pendant l\'annulation.');
        }
      });
    } catch (_error) {
      const back = await store.transition(organisationId, id, { from: ['undoing'], to: 'executed', patch: { undo: { by, at: iso(), failed: 'execution_failed' } }, at: iso() });
      await audit({ action: 'data_undo_outcome', organisationId, proposalId: id, decision: 'failed', reasons: ['execution_failed'], actor: by });
      return view(back ?? record, { code: 'execution_failed' });
    }
    if (!outcome.ok) {
      const back = await store.transition(organisationId, id, { from: ['undoing'], to: 'executed', patch: { undo: { by, at: iso(), failed: 'stale_data', detail: outcome.detail ?? null } }, at: iso() });
      await audit({ action: 'data_undo_outcome', organisationId, proposalId: id, decision: 'stale', reasons: ['stale_data'], actor: by });
      return view(back ?? record, { code: 'stale_data' });
    }
    await audit({ action: 'data_undo_outcome', organisationId, proposalId: id, decision: 'undone', actor: by, rowsAffected: outcome.rowsAffected });
    return view(await store.get(organisationId, id));
  }

  /** Annulation demandée dans l'application par une personne identifiée par elle. */
  async function undo(id, { organisationId, by } = {}) {
    const who = actorOf(by);
    if (!who || who.kind !== 'human') fail('approver_not_human', 'Seul un humain annule une action.');
    const record = await store.get(organisationId, id);
    if (!record) return { status: null, code: 'not_found' };
    return undoRecord(record, { by: who });
  }

  /** Passe en « expired » les propositions en attente dont la date est passée. */
  async function expire({ organisationId } = {}) {
    const waiting = await store.list({ organisationId, status: 'awaiting_validation', limit: 1000 });
    const expired = [];
    for (const record of waiting) {
      if (now() <= Date.parse(record.expiresAt)) continue;
      if (await store.transition(organisationId, record.id, { from: ['awaiting_validation'], to: 'expired', at: iso() })) {
        expired.push(record.id);
        await audit({ action: 'data_decision', organisationId, proposalId: record.id, decision: 'expired', reasons: ['expired'] });
      }
    }
    return expired;
  }

  /** Ce que l'application peut montrer ou transmettre : jamais le sel ni les valeurs sensibles en clair. */
  function view(record, extra = {}) {
    return {
      status: record.status, code: extra.code ?? null, level: record.level, reasons: record.reasons ?? [],
      proposal: record.proposal, explanation: record.explanation ?? null, result: record.result ?? null, undo: record.undo ?? null
    };
  }

  return Object.freeze({
    propose,
    applyValidation,
    undo,
    expire,
    get: async (id, { organisationId } = {}) => { const r = await store.get(organisationId, id); return r ? view(r) : null; },
    list: async (filter = {}) => (await store.list(filter)).map((r) => view(r)),
    /** Le défi à faire signer par la passkey, pour une validation dans l'application elle-même (mode hybride). */
    challengeFor: (proposal, { decision, approver, nonce }) => challengeFor({ propositionId: proposal.id, digest: proposal.digest, decision, environment, approver, nonce }),
    verifyDigest: (proposal) => isPlainObject(proposal) && proposal.digest === digestOf(withoutDigest(proposal)),
    environment
  });
}

module.exports = { createDataGovernance, STATUSES };
