const {
  FEEDBACK_REASONS,
  FEEDBACK_LABELS,
  FEEDBACK_COMMENT_MAX,
  resolveFeedbackLabels,
  feedbackPress,
  clampComment,
  buildFeedbackPayload,
  feedbackButtonState,
  feedbackReasonOptions
} = require('../src/logic');

describe('resolveFeedbackLabels', () => {
  test('English by default, French for any French locale', () => {
    expect(resolveFeedbackLabels().up).toBe('Good answer');
    expect(resolveFeedbackLabels({ locale: 'de' }).down).toBe('Bad answer');
    expect(resolveFeedbackLabels({ locale: 'fr-CA' }).down).toBe('Mauvaise réponse');
    expect(resolveFeedbackLabels({ locale: 'FR_fr' }).submit).toBe('Envoyer');
  });

  test('both languages name the same keys and every default reason', () => {
    expect(Object.keys(FEEDBACK_LABELS.fr).sort()).toEqual(Object.keys(FEEDBACK_LABELS.en).sort());
    for (const lang of ['en', 'fr']) {
      for (const reason of FEEDBACK_REASONS) expect(FEEDBACK_LABELS[lang].reasons[reason]).toBeTruthy();
    }
  });

  test("the app's words win, key by key; empty overrides are ignored", () => {
    const labels = resolveFeedbackLabels({ locale: 'fr', labels: { up: 'Top', down: '', reasons: { too_long: 'Verbeux', custom: 'Autre chose' }, counter: (a, b) => `${a} sur ${b}` } });
    expect(labels.up).toBe('Top');
    expect(labels.down).toBe('Mauvaise réponse');
    expect(labels.reasons.too_long).toBe('Verbeux');
    expect(labels.reasons.inaccurate).toBe('Inexacte');
    expect(labels.reasons.custom).toBe('Autre chose');
    expect(labels.counter(3, 9)).toBe('3 sur 9');
  });
});

describe('feedbackPress', () => {
  test('up is sent at once, down asks why, the chosen thumb withdraws', () => {
    expect(feedbackPress(null, 'up')).toEqual({ type: 'submit', payload: { rating: 'up' } });
    expect(feedbackPress('down', 'up')).toEqual({ type: 'submit', payload: { rating: 'up' } });
    expect(feedbackPress(null, 'down')).toEqual({ type: 'ask' });
    expect(feedbackPress('up', 'down')).toEqual({ type: 'ask' });
    expect(feedbackPress('up', 'up')).toEqual({ type: 'remove' });
    expect(feedbackPress('down', 'down')).toEqual({ type: 'remove' });
    expect(feedbackPress(null, 'sideways')).toEqual({ type: 'none' });
  });
});

describe('buildFeedbackPayload', () => {
  test('a reason and a comment only with down; blank comment dropped; trimmed', () => {
    expect(buildFeedbackPayload({ rating: 'up', reason: 'too_long', comment: 'nice' })).toEqual({ rating: 'up', comment: 'nice' });
    expect(buildFeedbackPayload({ rating: 'down', reason: 'too_long', comment: '  long  ' })).toEqual({ rating: 'down', reason: 'too_long', comment: 'long' });
    expect(buildFeedbackPayload({ rating: 'down', comment: '   ' })).toEqual({ rating: 'down' });
  });

  test('an unknown reason is dropped, an app reason accepted when listed', () => {
    expect(buildFeedbackPayload({ rating: 'down', reason: 'nonsense' })).toEqual({ rating: 'down' });
    expect(buildFeedbackPayload({ rating: 'down', reason: 'slow', reasons: ['slow'] })).toEqual({ rating: 'down', reason: 'slow' });
  });

  test('the comment is cut to the limit, whole characters only', () => {
    expect(buildFeedbackPayload({ rating: 'down', comment: 'a'.repeat(FEEDBACK_COMMENT_MAX + 10) }).comment).toHaveLength(FEEDBACK_COMMENT_MAX);
    expect(clampComment('😀😀😀', 2)).toBe('😀😀');
    expect(clampComment(undefined)).toBe('');
    expect(() => buildFeedbackPayload({ rating: 'meh' })).toThrow();
  });
});

describe('screen reader state and reason chips', () => {
  const labels = resolveFeedbackLabels();
  test('each thumb says its name and whether it is chosen', () => {
    expect(feedbackButtonState({ value: 'up', rating: 'up', labels })).toEqual({ selected: true, accessibilityRole: 'button', accessibilityLabel: 'Good answer', accessibilityState: { selected: true, disabled: false } });
    expect(feedbackButtonState({ value: 'up', rating: 'down', labels, disabled: true }).accessibilityState).toEqual({ selected: false, disabled: true });
  });

  test('chips follow the list, with the label or the id', () => {
    const options = feedbackReasonOptions({ reasons: ['too_long', 'custom'], labels, selected: 'custom' });
    expect(options).toEqual([{ id: 'too_long', label: 'Too long', selected: false }, { id: 'custom', label: 'custom', selected: true }]);
  });
});
