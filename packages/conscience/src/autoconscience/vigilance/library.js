'use strict';
/*
 * Candidate scenarios and their review (propositions 03 and 27).
 *
 * A candidate is plain data: `scenario` is a JSON description that `toScenario`
 * turns into a scenario for evaluateAgent of @astratra/testkit (id, question,
 * simulated tools, expect, score). Simulated tools return fixed data: they have
 * no effect on anything. A candidate is born "to_review". It joins the test
 * suite only through the library's approved() list, which retains a scenario
 * only when the governor holds a proposal for exactly that scenario (same
 * fingerprint) that humans approved. A model can propose; it cannot approve.
 */
const { ConscienceError } = require('../../errors');
const { fingerprintOf, copy } = require('../../governor/util');
const { ready, invalid, actorOf, maskerOf, maskText, maskDeep, isNonEmptyString } = require('./common');
const { VIGILANCE_STORE_METHODS } = require('./store');

const CATEGORIES = Object.freeze(['injection', 'ambiguity', 'edge_case', 'cross_organisation', 'regression']);
const REVIEW_STATUSES = Object.freeze(['to_review', 'approved', 'declined', 'rejected', 'expired']);
const LIMITS = Object.freeze({ question: 20000, text: 2000, items: 20 });

const stringList = (value, field, max = LIMITS.items) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max || !value.every((v) => isNonEmptyString(v) && v.length <= LIMITS.text)) invalid(`${field} must be an array of at most ${max} non-empty strings.`);
  return [...value];
};

function contentExpectation(item, allowRegex, field) {
  if (typeof item === 'string' && item.length && item.length <= LIMITS.text) return item;
  if (allowRegex && item instanceof RegExp && item.source.length <= 200) return { regex: item.source, flags: item.flags.replace(/[gy]/g, '') };
  if (allowRegex && item && typeof item === 'object' && typeof item.regex === 'string' && item.regex.length <= 200) {
    try { new RegExp(item.regex, item.flags ?? ''); } catch (_error) { invalid(`${field} holds an invalid regular expression.`); }
    return { regex: item.regex, flags: String(item.flags ?? '').replace(/[gy]/g, '') };
  }
  return invalid(`${field} must hold ${allowRegex ? 'strings or regular expressions' : 'strings'}.`);
}

/**
 * Validate and mask a scenario description. Everything textual passes through
 * the masker, so no personal content reaches a stored test.
 */
async function normalizeSpec(raw, { mask, allowRegex = false } = {}) {
  if (!raw || typeof raw !== 'object') invalid('A scenario description is required.');
  if (!isNonEmptyString(raw.question) || raw.question.length > LIMITS.question) invalid('scenario.question must be a non-empty string.');
  const tools = raw.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 10) invalid('scenario.tools must be an array of at most 10 simulated tools.');
  const names = new Set();
  const normalizedTools = [];
  for (const tool of tools) {
    if (!tool || !isNonEmptyString(tool.name) || tool.name.length > 200 || names.has(tool.name)) invalid('Each simulated tool needs a distinct name.');
    if (typeof tool.run === 'function') invalid('A scenario description holds data, not functions: use { name, returns }.');
    names.add(tool.name);
    normalizedTools.push({ name: tool.name, returns: await maskDeep(mask, copy(tool.returns ?? null)) });
  }
  const expect = raw.expect ?? {};
  const spec = {
    question: await maskText(mask, raw.question),
    tools: normalizedTools,
    expect: {
      tools: stringList(expect.tools, 'expect.tools'),
      content: await Promise.all((expect.content ?? []).map(async (item, index) => {
        const entry = contentExpectation(item, allowRegex, `expect.content[${index}]`);
        return typeof entry === 'string' ? maskText(mask, entry) : entry;
      }))
    },
    forbiddenTools: stringList(raw.forbiddenTools, 'forbiddenTools'),
    forbiddenContent: await Promise.all(stringList(raw.forbiddenContent, 'forbiddenContent').map((text) => maskText(mask, text)))
  };
  if (spec.expect.content.length > LIMITS.items) invalid('expect.content holds too many items.');
  return spec;
}

const hasAssertion = (spec) => spec.expect.tools.length + spec.expect.content.length + spec.forbiddenTools.length + spec.forbiddenContent.length > 0;

/** The scenario in the format of evaluateAgent: id, question, tools (fixed data), expect and a score. */
function toScenario(candidate) {
  const spec = candidate.scenario;
  const content = spec.expect.content.map((item) => (typeof item === 'string' ? item : new RegExp(item.regex, item.flags)));
  const scenario = {
    id: candidate.id,
    question: spec.question,
    tools: spec.tools.map((tool) => ({ name: tool.name, run: async () => copy(tool.returns) })),
    expect: { tools: [...spec.expect.tools], content }
  };
  if (spec.forbiddenTools.length || spec.forbiddenContent.length) {
    scenario.score = ({ text, calls, checks }) => {
      if (calls.some((call) => spec.forbiddenTools.includes(call.name))) return 0;
      if (spec.forbiddenContent.some((forbidden) => String(text).includes(forbidden))) return 0;
      return checks.length ? checks.filter((check) => check.passed).length / checks.length : 1;
    };
  }
  return scenario;
}

/** A candidate, born "to_review". The fingerprint covers organisation, agent, category and the whole description. */
function buildCandidate({ organisationId, agentId = null, category, origin, source, spec, now }) {
  if (!CATEGORIES.includes(category)) invalid(`category must be one of ${CATEGORIES.join(', ')}.`);
  if (!hasAssertion(spec)) invalid('A scenario must assert something (expect or forbidden).');
  const fingerprint = fingerprintOf({ organisationId, agentId, category, scenario: spec });
  const id = `${category === 'regression' ? 'reg' : 'adv'}_${fingerprint.slice(0, 24)}`;
  return {
    id, organisationId, agentId, category, origin: copy(origin), source, status: 'to_review', addedToTests: false,
    scenario: spec, fingerprint, proposalId: null, createdAt: new Date(now()).toISOString()
  };
}

function createScenarioLibrary(options = {}) {
  const { governor, store } = options;
  for (const method of VIGILANCE_STORE_METHODS) {
    if (!store || typeof store[method] !== 'function') throw new ConscienceError('store_invalid', `Vigilance store is missing ${method}().`);
  }
  maskerOf(options.masker); // A masker is mandatory: candidates are masked when built, the library refuses to run without one.
  const targetKind = options.targetKind ?? 'instructions';

  const targetOf = (candidate) => ({ kind: targetKind, id: `scenarios:${candidate.agentId ?? 'all'}` });

  async function submit(candidates, input = {}) {
    const organisationId = await ready(governor, input.organisationId);
    const proposedBy = actorOf(input.proposedBy, { kind: 'engine', id: 'scenario-library' });
    const out = [];
    for (const candidate of candidates) {
      governor.assertSingleOrganisation(organisationId, candidate.organisationId);
      const proposal = await governor.evaluatePolicy({
        organisationId, target: targetOf(candidate),
        change: { addScenario: { id: candidate.id, category: candidate.category, fingerprint: candidate.fingerprint }, reviewStatus: 'to_review' },
        justification: { code: `${candidate.category}_scenario`, origin: candidate.origin }, risk: 'low', proposedBy
      });
      const { record, created } = await store.putCandidate({ ...candidate, proposalId: proposal.id });
      out.push({ candidate: await withStatus(record), created, proposal });
    }
    return out;
  }

  async function withStatus(candidate) {
    const proposal = candidate.proposalId ? await governor.getProposal(candidate.organisationId, candidate.proposalId) : null;
    const status = !proposal ? 'to_review' : proposal.status === 'pending_approval' ? 'to_review' : proposal.status;
    const matches = proposal?.change?.addScenario?.fingerprint === candidate.fingerprint && proposal?.change?.addScenario?.id === candidate.id;
    const intact = fingerprintOf({ organisationId: candidate.organisationId, agentId: candidate.agentId, category: candidate.category, scenario: candidate.scenario }) === candidate.fingerprint;
    const humans = Array.isArray(proposal?.approvals) && proposal.approvals.length > 0 && proposal.approvals.every((a) => a.approver?.kind === 'human');
    const approved = status === 'approved' && matches && intact && humans;
    return { ...candidate, status: status === 'approved' && !approved ? 'rejected' : status, addedToTests: approved };
  }

  async function list(input = {}) {
    const organisationId = await ready(governor, input.organisationId);
    if (input.status != null && !REVIEW_STATUSES.includes(input.status)) invalid(`status must be one of ${REVIEW_STATUSES.join(', ')}.`);
    const filter = { organisationId, limit: input.limit };
    if (input.agentId !== undefined) filter.agentId = input.agentId;
    const all = await Promise.all((await store.listCandidates(filter)).map(withStatus));
    return all.filter((candidate) => input.status == null || candidate.status === input.status);
  }

  /** The only way into the test suite: scenarios whose exact content humans approved at the governor. */
  async function approved(input = {}) {
    const found = await list({ ...input, status: 'approved' });
    return found.filter((candidate) => candidate.addedToTests).map((candidate) => ({ candidate, scenario: toScenario(candidate) }));
  }

  return Object.freeze({ submit, list, approved, toScenario });
}

module.exports = { createScenarioLibrary, normalizeSpec, buildCandidate, toScenario, SCENARIO_CATEGORIES: CATEGORIES, CANDIDATE_STATUSES: REVIEW_STATUSES };
