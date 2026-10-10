import { createElement as h, useId, useState } from 'react';
import {
  FEEDBACK_COMMENT_MAX,
  FEEDBACK_REASONS,
  buildFeedbackPayload,
  feedbackPress,
  feedbackReasonOptions,
  resolveFeedbackLabels
} from '../lib/feedbackBar.js';

/**
 * The thumbs are drawn, never emoji (an emoji changes with the system and looks out of place in a
 * product). One outline on a 24 grid; down is the same hand turned upside down. Filled once chosen.
 */
export const THUMB_PATH = 'M7 21H4.5A1.5 1.5 0 0 1 3 19.5v-8A1.5 1.5 0 0 1 4.5 10H7M7 21V10l4.2-6.3A1.6 1.6 0 0 1 14 4.6V9h5a2 2 0 0 1 2 2.4l-1.5 7.9A2 2 0 0 1 17.5 21H7';

function thumbIcon(rating, filled) {
  return h('svg', {
    'aria-hidden': 'true', focusable: 'false', viewBox: '0 0 24 24', width: 18, height: 18,
    className: 'astratra-feedback__icon', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round'
  }, h('path', {
    d: THUMB_PATH,
    fill: filled ? 'currentColor' : 'none',
    fillOpacity: filled ? 0.9 : undefined,
    transform: rating === 'down' ? 'matrix(1 0 0 -1 0 24)' : undefined
  }));
}

/**
 * Thumbs up / thumbs down under an AI answer. Controlled: the app keeps
 * `value` and talks to its server in `onSubmit` / `onRemove`. Up is sent at
 * once; down opens a small panel for a reason and an optional comment;
 * pressing the chosen thumb again withdraws it. Words come from `labels` and
 * `locale`. Colours come from the kit's CSS variables, with fallbacks.
 */
export default function FeedbackBar({
  value = null, onSubmit, onRemove, disabled = false, reasons = FEEDBACK_REASONS, maxComment = FEEDBACK_COMMENT_MAX,
  labels, locale, icons, haptics, defaultOpen = false, className, style, id
}) {
  const words = resolveFeedbackLabels({ locale, labels });
  const [asking, setAsking] = useState(Boolean(defaultOpen));
  const [reason, setReason] = useState(null);
  const [comment, setComment] = useState('');
  const titleId = useId();
  const tick = () => { if (typeof haptics === 'function') { try { haptics(); } catch (_error) { /* never blocks a rating */ } } };
  const close = () => { setAsking(false); setReason(null); setComment(''); };
  const press = (rating) => {
    if (disabled) return;
    tick();
    const action = feedbackPress(value, rating);
    if (action.type === 'remove') onRemove?.();
    else if (action.type === 'ask') setAsking(true);
    else if (action.type === 'submit') onSubmit?.(action.payload);
  };
  const send = () => {
    tick();
    const payload = buildFeedbackPayload({ rating: 'down', reason, comment, reasons, maxComment });
    close();
    onSubmit?.(payload);
  };
  const thumb = (rating) => h('button', {
    key: rating, type: 'button', disabled, 'aria-pressed': value === rating, 'aria-label': words[rating], title: words[rating],
    className: 'astratra-feedback__thumb', 'data-rating': rating, onClick: () => press(rating)
  }, icons?.[rating] ?? thumbIcon(rating, value === rating));

  const options = feedbackReasonOptions({ reasons, labels: words, selected: reason });
  return h('div', { id, role: 'group', 'aria-label': words.group, className: ['astratra-feedback', className].filter(Boolean).join(' '), style },
    thumb('up'), thumb('down'),
    asking && h('div', {
      role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId, className: 'astratra-feedback__sheet',
      onKeyDown: (event) => { if (event.key === 'Escape') close(); }
    },
    h('p', { id: titleId, className: 'astratra-feedback__title' }, words.sheetTitle),
    h('div', { role: 'radiogroup', 'aria-labelledby': titleId, className: 'astratra-feedback__reasons' },
      options.map((option) => h('button', {
        key: option.id, type: 'button', role: 'radio', 'aria-checked': option.selected, className: 'astratra-feedback__chip',
        onClick: () => setReason(option.selected ? null : option.id)
      }, option.label))),
    h('label', { className: 'astratra-feedback__comment' },
      h('span', { className: 'astratra-feedback__label' }, words.commentLabel),
      h('textarea', { value: comment, maxLength: maxComment, placeholder: words.commentPlaceholder, rows: 3, onChange: (event) => setComment(event.target.value) }),
      h('span', { className: 'astratra-feedback__counter', 'aria-hidden': 'true' }, words.counter(Array.from(comment).length, maxComment))),
    h('div', { className: 'astratra-feedback__actions' },
      h('button', { type: 'button', className: 'astratra-feedback__cancel', onClick: close }, words.cancel),
      h('button', { type: 'button', className: 'astratra-feedback__send', onClick: send }, words.submit))));
}
