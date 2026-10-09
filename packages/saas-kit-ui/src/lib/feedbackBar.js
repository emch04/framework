// Pure rules of the feedback bar (thumbs up / down on an AI answer).
// Same rules as the mobile bar in @astratra/native-ui; no React here.

export const FEEDBACK_REASONS = Object.freeze(['inaccurate', 'incomplete', 'off_topic', 'wrong_source', 'too_long', 'unsafe', 'other']);
export const FEEDBACK_COMMENT_MAX = 500;

export const FEEDBACK_LABELS = Object.freeze({
  en: Object.freeze({
    group: 'Rate this answer', up: 'Good answer', down: 'Bad answer', sheetTitle: 'What went wrong?',
    commentLabel: 'Comment (optional)', commentPlaceholder: 'Tell us more (optional)', submit: 'Send', cancel: 'Cancel',
    reasons: Object.freeze({ inaccurate: 'Inaccurate', incomplete: 'Incomplete', off_topic: 'Off topic', wrong_source: 'Wrong source', too_long: 'Too long', unsafe: 'Unsafe', other: 'Other' }),
    counter: (used, max) => `${used}/${max}`
  }),
  fr: Object.freeze({
    group: 'Évaluer cette réponse', up: 'Bonne réponse', down: 'Mauvaise réponse', sheetTitle: "Qu'est-ce qui n'allait pas ?",
    commentLabel: 'Commentaire (facultatif)', commentPlaceholder: 'Dites-nous en plus (facultatif)', submit: 'Envoyer', cancel: 'Annuler',
    reasons: Object.freeze({ inaccurate: 'Inexacte', incomplete: 'Incomplète', off_topic: 'Hors sujet', wrong_source: 'Mauvaise source', too_long: 'Trop longue', unsafe: 'Dangereuse', other: 'Autre' }),
    counter: (used, max) => `${used}/${max}`
  })
});

const TEXT_KEYS = ['group', 'up', 'down', 'sheetTitle', 'commentLabel', 'commentPlaceholder', 'submit', 'cancel'];

/** Labels for a locale ('fr…' is French, anything else English), with the app's overrides on top. */
export function resolveFeedbackLabels({ locale, labels } = {}) {
  const language = typeof locale === 'string' ? locale.toLowerCase().split(/[-_]/)[0] : 'en';
  const base = FEEDBACK_LABELS[language] || FEEDBACK_LABELS.en;
  const given = labels && typeof labels === 'object' ? labels : {};
  const out = {};
  for (const key of TEXT_KEYS) out[key] = typeof given[key] === 'string' && given[key] ? given[key] : base[key];
  out.reasons = { ...base.reasons, ...(given.reasons && typeof given.reasons === 'object' ? given.reasons : {}) };
  out.counter = typeof given.counter === 'function' ? given.counter : base.counter;
  return out;
}

/** What pressing a thumb does: withdraw the chosen one, send up at once, ask why for down. */
export function feedbackPress(value, rating) {
  if (rating !== 'up' && rating !== 'down') return { type: 'none' };
  if (value === rating) return { type: 'remove' };
  return rating === 'up' ? { type: 'submit', payload: { rating: 'up' } } : { type: 'ask' };
}

export function clampComment(text, max = FEEDBACK_COMMENT_MAX) {
  if (typeof text !== 'string') return '';
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** The body to send: a reason only with 'down' and only if listed; blank comment dropped; trimmed and cut. */
export function buildFeedbackPayload({ rating, reason, comment, reasons = FEEDBACK_REASONS, maxComment = FEEDBACK_COMMENT_MAX } = {}) {
  if (rating !== 'up' && rating !== 'down') throw new Error("rating must be 'up' or 'down'.");
  const payload = { rating };
  if (rating === 'down' && typeof reason === 'string' && reasons.includes(reason)) payload.reason = reason;
  const text = clampComment(typeof comment === 'string' ? comment.trim() : '', maxComment).trim();
  if (text) payload.comment = text;
  return payload;
}

export function feedbackReasonOptions({ reasons = FEEDBACK_REASONS, labels, selected }) {
  return reasons.map((id) => ({ id, label: labels.reasons[id] || id, selected: id === selected }));
}
