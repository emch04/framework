'use strict';

function createConfidentialPolicy({ defaultRoles = [], lockedRoles = [], cloudFallbackRoles = [], localUnsupportedLanguages = [], defaultMode = 'normal' } = {}) {
  function decide({ role, requestedMode, language } = {}) {
    if (lockedRoles.includes(role)) return { mode: 'confidential', cloudAudioAllowed: false, reason: 'ROLE_LOCKED' };
    const selected = requestedMode || (defaultRoles.includes(role) ? 'confidential' : defaultMode);
    if (selected === 'confidential' && localUnsupportedLanguages.includes(language)) {
      return { mode: 'normal', cloudAudioAllowed: true, reason: 'LOCAL_LANGUAGE_UNAVAILABLE' };
    }
    return selected === 'confidential'
      ? { mode: 'confidential', cloudAudioAllowed: false, reason: 'CONFIDENTIAL_SELECTED' }
      : { mode: 'normal', cloudAudioAllowed: true, reason: 'NORMAL_SELECTED' };
  }
  function onLocalFailure(session = {}) {
    const current = decide(session);
    if (current.mode !== 'confidential') return current;
    if (!lockedRoles.includes(session.role) && cloudFallbackRoles.includes(session.role) && session.allowCloudFallback === true) {
      return { mode: 'normal', cloudAudioAllowed: true, reason: 'LOCAL_FAILURE_FALLBACK' };
    }
    return { mode: 'confidential', cloudAudioAllowed: false, reason: 'LOCAL_FAILURE_CLOUD_DENIED' };
  }
  return { decide, onLocalFailure };
}

/** Per-call counters from the local speech loop; no transport or user text. */
function createConfidentialSession(policy, session = {}, { doubtLimit = 2, failureLimit = 2 } = {}) {
  let decision = policy.decide(session);
  let state = 'active';
  let doubts = 0;
  let failures = 0;
  let reason = decision.reason;
  const snapshot = () => ({ ...decision, state, doubts, failures, reason });
  return {
    snapshot,
    onAccepted() {
      if (state !== 'ended') { doubts = 0; failures = 0; reason = 'ACCEPTED'; }
      return snapshot();
    },
    onDoubt() {
      if (state === 'ended') return snapshot();
      doubts += 1;
      const fallback = policy.onLocalFailure(session);
      if (doubts >= doubtLimit && fallback.cloudAudioAllowed && decision.mode === 'confidential') {
        decision = fallback; reason = 'CONFIDENCE_FALLBACK';
      } else reason = 'REPEAT_REQUESTED';
      return snapshot();
    },
    onLocalFailure() {
      if (state === 'ended') return snapshot();
      if (decision.mode === 'normal') return snapshot();
      failures += 1;
      const fallback = policy.onLocalFailure(session);
      if (fallback.cloudAudioAllowed && decision.mode === 'confidential') { decision = fallback; reason = fallback.reason; }
      else if (failures >= failureLimit) { state = 'ended'; reason = 'LOCAL_UNAVAILABLE'; }
      else reason = 'RETRY_LOCAL';
      return snapshot();
    },
    end() { state = 'ended'; reason = 'SESSION_ENDED'; return snapshot(); }
  };
}

module.exports = { createConfidentialPolicy, createConfidentialSession };
