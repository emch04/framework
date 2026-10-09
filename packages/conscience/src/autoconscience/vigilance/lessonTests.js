'use strict';
/*
 * Lesson turned into a test (proposition 03). A VERIFIED lesson (P2: evidence,
 * enough distinct decisions, no open conflict) becomes an anti-regression
 * scenario in the format of evaluateAgent. A hypothesis, a lesson to reassess
 * or a retired one is refused: a doubtful lesson must not become a test.
 *
 * The lesson says what was learned; how to check it is described by the caller
 * (question, fixed tool results, expected and forbidden behaviour): nothing is
 * invented. A scenario that asserts nothing is refused. The result is a
 * candidate "to_review"; it enters the suite only after human approval at the
 * governor (see createScenarioLibrary).
 */
const { ConscienceError } = require('../../errors');
const { ready, invalid, maskerOf, isNonEmptyString } = require('./common');
const { normalizeSpec, buildCandidate } = require('./library');

async function lessonToScenario(lesson, options = {}) {
  const { governor, library } = options;
  const organisationId = await ready(governor, options.organisationId ?? lesson?.organisationId);
  if (!lesson || typeof lesson !== 'object' || !isNonEmptyString(lesson.id)) invalid('A lesson read from the conscience is required.');
  governor.assertSingleOrganisation(organisationId, lesson.organisationId);
  if (lesson.status !== 'verified') {
    throw new ConscienceError('lesson_not_verified', `Only a verified lesson can become a test; this one is "${lesson.status}".`);
  }
  if (!Array.isArray(lesson.evidence) || !lesson.evidence.length) throw new ConscienceError('lesson_not_verified', 'A lesson without evidence cannot become a test.');
  const mask = maskerOf(options.masker);
  const spec = await normalizeSpec({
    question: options.question, tools: options.tools, expect: options.expect,
    forbiddenTools: options.forbiddenTools, forbiddenContent: options.forbiddenContent
  }, { mask, allowRegex: true });
  const candidate = buildCandidate({
    organisationId, agentId: lesson.agentId ?? options.agentId ?? null, category: 'regression', source: 'lesson', spec, now: options.now ?? Date.now,
    origin: { lessonId: lesson.id, revisionId: lesson.revisionId ?? null, domain: lesson.domain ?? null, evidence: lesson.evidence.map((e) => ({ kind: e.kind, ref: e.ref })) }
  });
  if (library) return (await library.submit([candidate], { organisationId, proposedBy: options.proposedBy }))[0].candidate;
  return candidate;
}

module.exports = { lessonToScenario };
