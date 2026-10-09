/**
 * The rules of the feedback bar (thumbs up / down on an AI answer), dry:
 * what a press does, what is sent, what the screen reader says, which words
 * appear. No react-native here — importable and testable from plain Node.
 *
 * The words are the app's. The defaults (English, French) only keep the bar
 * usable out of the box; every label can be overridden.
 */

/** The reasons the server accepts by default, in the order the sheet lists them. */
const FEEDBACK_REASONS = Object.freeze(['inaccurate', 'incomplete', 'off_topic', 'wrong_source', 'too_long', 'unsafe', 'other']);

/** Default comment limit; the server's own limit is the one that counts. */
const FEEDBACK_COMMENT_MAX = 500;

const FEEDBACK_LABELS = Object.freeze({
  en: Object.freeze({
    group: 'Rate this answer',
    up: 'Good answer',
    down: 'Bad answer',
    sheetTitle: 'What went wrong?',
    commentLabel: 'Comment (optional)',
    commentPlaceholder: 'Tell us more (optional)',
    submit: 'Send',
    cancel: 'Cancel',
    reasons: Object.freeze({
      inaccurate: 'Inaccurate',
      incomplete: 'Incomplete',
      off_topic: 'Off topic',
      wrong_source: 'Wrong source',
      too_long: 'Too long',
      unsafe: 'Unsafe',
      other: 'Other'
    }),
    counter: (used, max) => `${used}/${max}`
  }),
  fr: Object.freeze({
    group: 'Évaluer cette réponse',
    up: 'Bonne réponse',
    down: 'Mauvaise réponse',
    sheetTitle: "Qu'est-ce qui n'allait pas ?",
    commentLabel: 'Commentaire (facultatif)',
    commentPlaceholder: 'Dites-nous en plus (facultatif)',
    submit: 'Envoyer',
    cancel: 'Annuler',
    reasons: Object.freeze({
      inaccurate: 'Inexacte',
      incomplete: 'Incomplète',
      off_topic: 'Hors sujet',
      wrong_source: 'Mauvaise source',
      too_long: 'Trop longue',
      unsafe: 'Dangereuse',
      other: 'Autre'
    }),
    counter: (used, max) => `${used}/${max}`
  })
});

/**
 * The labels for a locale (`'fr'`, `'fr-CA'`… → French, anything else →
 * English), with the app's overrides on top. A reason the app adds needs its
 * own label; without one, the id itself is shown.
 */
function resolveFeedbackLabels({ locale, labels } = {}) {
  const language = typeof locale === 'string' ? locale.toLowerCase().split(/[-_]/)[0] : 'en';
  const base = FEEDBACK_LABELS[language] || FEEDBACK_LABELS.en;
  const given = labels && typeof labels === 'object' ? labels : {};
  const pick = (key) => (typeof given[key] === 'string' && given[key] ? given[key] : base[key]);
  return {
    group: pick('group'),
    up: pick('up'),
    down: pick('down'),
    sheetTitle: pick('sheetTitle'),
    commentLabel: pick('commentLabel'),
    commentPlaceholder: pick('commentPlaceholder'),
    submit: pick('submit'),
    cancel: pick('cancel'),
    reasons: { ...base.reasons, ...(given.reasons && typeof given.reasons === 'object' ? given.reasons : {}) },
    counter: typeof given.counter === 'function' ? given.counter : base.counter
  };
}

/**
 * What pressing a thumb does, given the current choice:
 *   the thumb already chosen  → withdraw it;
 *   thumbs up                 → send it at once;
 *   thumbs down               → ask why first.
 */
function feedbackPress(value, rating) {
  if (rating !== 'up' && rating !== 'down') return { type: 'none' };
  if (value === rating) return { type: 'remove' };
  return rating === 'up' ? { type: 'submit', payload: { rating: 'up' } } : { type: 'ask' };
}

/** The comment cut to the limit, never sliced inside a surrogate pair. */
function clampComment(text, max = FEEDBACK_COMMENT_MAX) {
  if (typeof text !== 'string') return '';
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * The body sent for a rating. A reason only goes with 'down' and only if the
 * list allows it; a blank comment is dropped; the comment is trimmed and cut.
 */
function buildFeedbackPayload({ rating, reason, comment, reasons = FEEDBACK_REASONS, maxComment = FEEDBACK_COMMENT_MAX } = {}) {
  if (rating !== 'up' && rating !== 'down') throw new Error("rating must be 'up' or 'down'.");
  const payload = { rating };
  if (rating === 'down' && typeof reason === 'string' && reasons.includes(reason)) payload.reason = reason;
  const text = clampComment(typeof comment === 'string' ? comment.trim() : '', maxComment).trim();
  if (text) payload.comment = text;
  return payload;
}

/** What each thumb tells the screen reader. */
function feedbackButtonState({ value, rating, labels, disabled = false }) {
  const selected = value === rating;
  return {
    selected,
    accessibilityRole: 'button',
    accessibilityLabel: rating === 'up' ? labels.up : labels.down,
    accessibilityState: { selected, disabled: Boolean(disabled) }
  };
}

/** The sheet's chips: id, visible label, selected or not. */
function feedbackReasonOptions({ reasons = FEEDBACK_REASONS, labels, selected }) {
  return reasons.map((id) => ({ id, label: labels.reasons[id] || id, selected: id === selected }));
}

module.exports = {
  FEEDBACK_REASONS,
  FEEDBACK_COMMENT_MAX,
  FEEDBACK_LABELS,
  resolveFeedbackLabels,
  feedbackPress,
  clampComment,
  buildFeedbackPayload,
  feedbackButtonState,
  feedbackReasonOptions
};
