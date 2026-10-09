'use strict';
const { minimum } = require('./statistics');
const DEGREE = ['none', 'anecdotal', 'observational', 'experimental', 'replicated'];
function oppositeLessons(a, b) {
  return a.id !== b.id && a.organisationId === b.organisationId && a.userId === b.userId && a.agentId === b.agentId
    && a.domain === b.domain && a.subject != null && a.subject === b.subject && a.stance != null && b.stance != null && a.stance !== b.stance
    && a.status !== 'retired' && b.status !== 'retired';
}
/** Recommendations only: conflicting lessons stay open until explicitly arbitrated. Newer alone is not proof. */
function evaluateLessonConflicts(lessons, options = {}) {
  const conflicts = [];
  for (let i = 0; i < lessons.length; i += 1) {
    for (const b of lessons.slice(i + 1)) {
      const a = lessons[i];
      if (!oppositeLessons(a, b)) continue;
      const sufficient = (l) => l.evidence.length > 0 && (l.sampleSize ?? 0) >= minimum(options.minimumSample);
      const rank = (l) => sufficient(l) ? DEGREE.indexOf(l.evidenceDegree) : -1;
      const ar = rank(a), br = rank(b);
      const newer = (a.validFrom ?? a.recordedAt) > (b.validFrom ?? b.recordedAt) ? a : b;
      const preferred = ar > br ? a : br > ar ? b : null;
      conflicts.push({ lessonIds: [a.id, b.id].sort(), subject: a.subject, domain: a.domain, status: 'open', lessonStatus: 'to_reassess',
        preferredLessonId: preferred?.id ?? null, newerLessonId: newer.id, reason: preferred ? 'stronger_evidence' : 'inconclusive',
        evidence: [...a.evidence, ...b.evidence] });
    }
  }
  return conflicts;
}
function assessedLessonStatus({ evidence, sampleSize, contradictions = [], factualEligible = true }, options = {}) {
  if (contradictions.length) return 'to_reassess';
  return evidence.length && sampleSize >= minimum(options.minimumSample) && factualEligible ? 'verified' : 'hypothesis';
}
module.exports = { oppositeLessons, evaluateLessonConflicts, assessedLessonStatus };
