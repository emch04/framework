import { createElement as h, useId, useState } from 'react';
import {
  FEEDBACK_COMMENT_MAX,
  FEEDBACK_REASONS,
  buildFeedbackPayload,
  feedbackPress,
  feedbackReasonOptions,
  resolveFeedbackLabels
} from '../lib/feedbackBar.js';

const THUMBS = { up: '\u{1F44D}', down: '\u{1F44E}' };

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
  }, icons?.[rating] ?? h('span', { 'aria-hidden': 'true' }, THUMBS[rating]));

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
