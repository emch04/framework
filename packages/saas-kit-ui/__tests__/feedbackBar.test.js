import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import FeedbackBar from '../src/components/FeedbackBar.js';
import {
  FEEDBACK_COMMENT_MAX, FEEDBACK_LABELS, FEEDBACK_REASONS, buildFeedbackPayload, clampComment, feedbackPress, feedbackReasonOptions, resolveFeedbackLabels
} from '../src/lib/feedbackBar.js';

test('labels: English default, French locale, app overrides', () => {
  assert.equal(resolveFeedbackLabels().up, 'Good answer');
  assert.equal(resolveFeedbackLabels({ locale: 'fr-FR' }).down, 'Mauvaise réponse');
  const own = resolveFeedbackLabels({ locale: 'fr', labels: { up: 'Top', down: '', reasons: { custom: 'Spécial' }, counter: (a, b) => `${a}|${b}` } });
  assert.deepEqual([own.up, own.down, own.reasons.custom, own.reasons.too_long, own.counter(1, 2)], ['Top', 'Mauvaise réponse', 'Spécial', 'Trop longue', '1|2']);
  assert.deepEqual(Object.keys(FEEDBACK_LABELS.fr).sort(), Object.keys(FEEDBACK_LABELS.en).sort());
  for (const reason of FEEDBACK_REASONS) assert.ok(FEEDBACK_LABELS.fr.reasons[reason] && FEEDBACK_LABELS.en.reasons[reason]);
});

test('press rules: up at once, down asks, chosen thumb withdraws', () => {
  assert.deepEqual(feedbackPress(null, 'up'), { type: 'submit', payload: { rating: 'up' } });
  assert.deepEqual(feedbackPress('up', 'down'), { type: 'ask' });
  assert.deepEqual(feedbackPress('down', 'down'), { type: 'remove' });
  assert.deepEqual(feedbackPress('up', 'up'), { type: 'remove' });
  assert.deepEqual(feedbackPress(null, 'x'), { type: 'none' });
});

test('payload: reason only with down and only if listed, comment trimmed and cut', () => {
  assert.deepEqual(buildFeedbackPayload({ rating: 'up', reason: 'too_long', comment: ' ok ' }), { rating: 'up', comment: 'ok' });
  assert.deepEqual(buildFeedbackPayload({ rating: 'down', reason: 'too_long', comment: '  ' }), { rating: 'down', reason: 'too_long' });
  assert.deepEqual(buildFeedbackPayload({ rating: 'down', reason: 'nope' }), { rating: 'down' });
  assert.deepEqual(buildFeedbackPayload({ rating: 'down', reason: 'slow', reasons: ['slow'] }), { rating: 'down', reason: 'slow' });
  assert.equal(buildFeedbackPayload({ rating: 'down', comment: 'a'.repeat(900) }).comment.length, FEEDBACK_COMMENT_MAX);
  assert.equal(clampComment('😀😀😀', 2), '😀😀');
  assert.throws(() => buildFeedbackPayload({ rating: 'meh' }));
  assert.deepEqual(feedbackReasonOptions({ reasons: ['a', 'too_long'], labels: resolveFeedbackLabels(), selected: 'a' }).map((o) => [o.id, o.label, o.selected]), [['a', 'a', true], ['too_long', 'Too long', false]]);
});

test('markup: a labelled group of two pressable buttons, state exposed', () => {
  const html = renderToStaticMarkup(h(FeedbackBar, { value: 'up' }));
  assert.match(html, /role="group"[^>]*aria-label="Rate this answer"|aria-label="Rate this answer"[^>]*role="group"/);
  assert.match(html, /aria-pressed="true"[^>]*aria-label="Good answer"|aria-label="Good answer"[^>]*aria-pressed="true"/);
  assert.match(html, /aria-pressed="false"/);
  assert.equal((html.match(/<button/g) || []).length, 2);
  assert.doesNotMatch(html, /role="dialog"/);
});

test('markup: French, custom words and disabled state', () => {
  const html = renderToStaticMarkup(h(FeedbackBar, { locale: 'fr', labels: { up: 'Super' }, disabled: true }));
  assert.match(html, /aria-label="Super"/); assert.match(html, /aria-label="Mauvaise réponse"/); assert.equal((html.match(/disabled=""/g) || []).length, 2);
});

test('markup: the open panel is a dialog with reasons, comment limit and actions', () => {
  const html = renderToStaticMarkup(h(FeedbackBar, { defaultOpen: true, maxComment: 120, reasons: ['too_long', 'slow'], labels: { reasons: { slow: 'Too slow' } } }));
  assert.match(html, /role="dialog"/); assert.match(html, /What went wrong\?/);
  assert.match(html, /role="radiogroup"/); assert.equal((html.match(/role="radio"/g) || []).length, 2);
  assert.match(html, />Too long</); assert.match(html, />Too slow</);
  assert.match(html, /maxLength="120"/); assert.match(html, />Send</); assert.match(html, />Cancel</); assert.match(html, />0\/120</);
});

test('the package entry also exports the bar and its rules', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/index.jsx', import.meta.url), 'utf8'));
  assert.match(source, /FeedbackBar/); assert.match(source, /buildFeedbackPayload/);
});
