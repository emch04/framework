/**
 * Thumbs up / thumbs down under an AI answer.
 *
 * Two discreet glass buttons. Up is sent at once; down opens a sheet for the
 * reason and an optional comment. Pressing the chosen thumb again withdraws
 * it. The bar is controlled: the app keeps `value` and talks to its server in
 * `onSubmit` / `onRemove` (see `createFeedbackRouter` in @astratra/agent).
 *
 * Words come from the app (`labels`, `locale`); the haptic tick is optional
 * (expo-haptics when installed, or the function the app passes).
 */
const { React, h, RN, useScheme } = require('./runtime');
const { GlassButton } = require('./GlassButton');
const { usePaleCardColors } = require('./PaleCard');
const {
  FEEDBACK_REASONS,
  FEEDBACK_COMMENT_MAX,
  resolveFeedbackLabels,
  feedbackPress,
  buildFeedbackPayload,
  feedbackButtonState,
  feedbackReasonOptions
} = require('../logic/feedbackBar');

const DEFAULT_ACCENT = '#3b6cf0';

/* expo-haptics is an optional peer: absent, the bar is silent. */
let cachedHaptics;
function loadHaptics() {
  if (cachedHaptics !== undefined) return cachedHaptics;
  try {
    const mod = require('expo-haptics');
    cachedHaptics = mod && (mod.default || mod);
  } catch (_error) {
    cachedHaptics = null;
  }
  return cachedHaptics;
}

function tick(haptics) {
  if (haptics === false) return;
  try {
    if (typeof haptics === 'function') return void haptics();
    const lib = loadHaptics();
    if (lib && typeof lib.selectionAsync === 'function') Promise.resolve(lib.selectionAsync()).catch(() => {});
  } catch (_error) {
    /* A missing tick never blocks a rating. */
  }
}

function FeedbackBar({
  value = null,
  onSubmit,
  onRemove,
  disabled = false,
  reasons = FEEDBACK_REASONS,
  maxComment = FEEDBACK_COMMENT_MAX,
  labels,
  locale,
  icons,
  haptics,
  accent = DEFAULT_ACCENT,
  size = 34,
  scheme: schemeOverride,
  pageBackground,
  ink,
  style,
  testID
}) {
  const scheme = useScheme(schemeOverride);
  const words = resolveFeedbackLabels({ locale, labels });
  const [asking, setAsking] = React.useState(false);
  const [reason, setReason] = React.useState(null);
  const [comment, setComment] = React.useState('');
  const card = usePaleCardColors({ tint: accent, pageBackground, ink, scheme });
  const textColor = ink || (scheme === 'dark' ? '#ffffff' : '#0d1235');

  const close = () => {
    setAsking(false);
    setReason(null);
    setComment('');
  };
  const press = (rating) => {
    if (disabled) return;
    tick(haptics);
    const action = feedbackPress(value, rating);
    if (action.type === 'remove') {
      if (onRemove) onRemove();
    } else if (action.type === 'ask') {
      setAsking(true);
    } else if (action.type === 'submit' && onSubmit) {
      onSubmit(action.payload);
    }
  };
  const send = () => {
    tick(haptics);
    const payload = buildFeedbackPayload({ rating: 'down', reason, comment, reasons, maxComment });
    close();
    if (onSubmit) onSubmit(payload);
  };

  const thumb = (rating, glyph) => {
    const state = feedbackButtonState({ value, rating, labels: words, disabled });
    return h(
      GlassButton,
      {
        key: rating,
        size,
        scheme,
        disabled,
        selected: state.selected,
        tint: state.selected ? accent : undefined,
        accessibilityLabel: state.accessibilityLabel,
        testID: testID ? `${testID}-${rating}` : undefined,
        onPress: () => press(rating)
      },
      icons && icons[rating] ? icons[rating] : h(RN.Text, { style: { fontSize: Math.round(size * 0.46) } }, glyph)
    );
  };

  const chip = (option) =>
    h(
      RN.Pressable,
      {
        key: option.id,
        testID: testID ? `${testID}-reason-${option.id}` : undefined,
        accessibilityRole: 'radio',
        accessibilityLabel: option.label,
        accessibilityState: { selected: option.selected },
        onPress: () => setReason(option.selected ? null : option.id),
        style: {
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 16,
          backgroundColor: option.selected ? accent : card.fill
        }
      },
      h(RN.Text, { style: { color: option.selected ? '#ffffff' : textColor, fontSize: 14 } }, option.label)
    );

  return h(
    RN.View,
    { testID, accessibilityRole: 'toolbar', accessibilityLabel: words.group, style: [{ flexDirection: 'row', alignItems: 'center', gap: 8 }, style] },
    thumb('up', '\u{1F44D}'),
    thumb('down', '\u{1F44E}'),
    h(
      RN.Modal,
      { visible: asking, transparent: true, animationType: 'slide', onRequestClose: close },
      h(
        RN.View,
        { style: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' } },
        h(
          RN.View,
          {
            accessibilityViewIsModal: true,
            style: { padding: 20, gap: 14, borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: pageBackground || (scheme === 'dark' ? '#1c1c1e' : '#ffffff') }
          },
          h(RN.Text, { accessibilityRole: 'header', style: { color: textColor, fontSize: 17, fontWeight: '600' } }, words.sheetTitle),
          h(RN.View, { accessibilityRole: 'radiogroup', style: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } }, feedbackReasonOptions({ reasons, labels: words, selected: reason }).map(chip)),
          h(RN.TextInput, {
            testID: testID ? `${testID}-comment` : undefined,
            accessibilityLabel: words.commentLabel,
            placeholder: words.commentPlaceholder,
            value: comment,
            maxLength: maxComment,
            multiline: true,
            onChangeText: (text) => setComment(text),
            style: { minHeight: 72, padding: 12, borderRadius: 14, color: textColor, backgroundColor: card.fill, textAlignVertical: 'top' }
          }),
          h(RN.Text, { style: { color: textColor, opacity: 0.55, fontSize: 12, textAlign: 'right' } }, words.counter(Array.from(comment).length, maxComment)),
          h(
            RN.View,
            { style: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 } },
            h(RN.Pressable, { testID: testID ? `${testID}-cancel` : undefined, accessibilityRole: 'button', accessibilityLabel: words.cancel, onPress: close, style: { paddingHorizontal: 16, paddingVertical: 10 } }, h(RN.Text, { style: { color: textColor } }, words.cancel)),
            h(RN.Pressable, { testID: testID ? `${testID}-send` : undefined, accessibilityRole: 'button', accessibilityLabel: words.submit, onPress: send, style: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 20, backgroundColor: accent } }, h(RN.Text, { style: { color: '#ffffff', fontWeight: '600' } }, words.submit))
          )
        )
      )
    )
  );
}

module.exports = { FeedbackBar };
