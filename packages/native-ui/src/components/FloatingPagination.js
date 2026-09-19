/**
 * List pagination as a pill that floats at the bottom, like the tab bar.
 *
 * It used to be a footer bar that ate the bottom of the screen, then a
 * selector at the end of the list that had to be scrolled to. Now: a round
 * pill, glass on iOS (the same as the tab bar), a light card on Android. It
 * stays put while the list passes under it, and behaves like the tab bar: it
 * shrinks when scrolling down, returns when scrolling up (`collapse`, from
 * `useCollapsingBar`). Keep `paginationReserve(bottomInset)` of room under the
 * list so its last row can scroll above the pill.
 */
const { h, RN, AnimatedView, GlassEffect, getGlassMode, useScheme } = require('./runtime');
const { useCollapseTransform } = require('./useCollapsingBar');
const { Chevron } = require('./Chevron');
const { PAGINATION_HEIGHT } = require('../logic/tabBar');
const { floatingBottomOffset } = require('../logic/collapse');

/* Properly round, like the tab bar: the ends are half circles. */
const glassShape = { height: PAGINATION_HEIGHT, borderRadius: PAGINATION_HEIGHT / 2, overflow: 'hidden' };
const cardShape = {
  height: PAGINATION_HEIGHT,
  borderRadius: PAGINATION_HEIGHT / 2,
  backgroundColor: '#fdfdff',
  borderWidth: RN.StyleSheet.hairlineWidth,
  borderColor: 'rgba(13,18,53,0.06)',
  shadowColor: '#18234f',
  shadowOpacity: 0.14,
  shadowRadius: 22,
  shadowOffset: { width: 0, height: 10 },
  elevation: 8
};
const darkCard = { backgroundColor: '#1c1c1e', borderColor: 'rgba(255,255,255,0.08)' };

function FloatingPagination({
  page,
  totalPages,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  previousLabel,
  nextLabel,
  collapse,
  bottom,
  bottomInset = 0,
  onHaptic,
  previousIcon,
  nextIcon,
  scheme: schemeOverride,
  testID
}) {
  const scheme = useScheme(schemeOverride);
  const dark = scheme === 'dark';
  const ink = dark ? '#ffffff' : '#0d1235';
  const foldStyle = useCollapseTransform(collapse);
  const glass = getGlassMode() === 'native';

  const arrow = (label, icon, enabled, onPress) =>
    h(
      RN.Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: label,
        accessibilityState: { disabled: !enabled },
        disabled: !enabled,
        hitSlop: 6,
        onPress: () => {
          if (onHaptic) onHaptic();
          onPress();
        },
        style: ({ pressed }) => [
          { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
          pressed ? { backgroundColor: dark ? 'rgba(255,255,255,0.12)' : 'rgba(13,18,53,0.08)' } : null,
          enabled ? null : { opacity: 0.3 }
        ]
      },
      icon
    );

  return h(
    AnimatedView,
    {
      pointerEvents: 'box-none',
      testID,
      style: [
        {
          position: 'absolute',
          left: 0,
          right: 0,
          alignItems: 'center',
          /* A fixed button already in the page's footer: the pill sits above
             it instead of covering it. Otherwise, the tab bar's place. */
          bottom: bottom ?? floatingBottomOffset(bottomInset),
          transformOrigin: 'bottom'
        },
        foldStyle
      ]
    },
    h(
      RN.View,
      { style: glass ? glassShape : [cardShape, dark ? darkCard : null] },
      glass
        ? h(GlassEffect.GlassView, {
            glassEffectStyle: 'regular',
            tintColor: dark ? 'rgba(0,0,0,0.62)' : 'rgba(255,255,255,0.42)',
            colorScheme: scheme,
            style: RN.StyleSheet.absoluteFill
          })
        : null,
      h(
        RN.View,
        { style: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, gap: 2 } },
        arrow(previousLabel, previousIcon || h(Chevron, { direction: 'left', color: ink }), canPrevious, onPrevious),
        h(
          RN.Text,
          {
            style: {
              minWidth: 70,
              textAlign: 'center',
              fontWeight: '600',
              fontSize: 13,
              fontVariant: ['tabular-nums'],
              color: dark ? 'rgba(255,255,255,0.7)' : '#5c6178'
            }
          },
          h(RN.Text, { style: { fontWeight: '800', fontSize: 15, color: ink } }, String(page)),
          `  /  ${totalPages}`
        ),
        arrow(nextLabel, nextIcon || h(Chevron, { direction: 'right', color: ink }), canNext, onNext)
      )
    )
  );
}

module.exports = { FloatingPagination };
