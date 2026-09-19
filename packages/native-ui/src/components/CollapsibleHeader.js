/**
 * The page header that folds on scroll, and the screen that wires it.
 *
 * The rule — fixed back button and actions, large title scrolling away, a
 * small blurred bar carrying the page name once the title has gone, a fade
 * under it rather than a line — and its numbers are in
 * logic/collapsibleHeader.js.
 *
 * On iOS the bar is the system's blur (the material of Apple's bars), masked
 * by a gradient so it dies out in the overflow. The mask needs a MaskedView,
 * which is injected (`MaskedView` prop, e.g. `@react-native-masked-view/
 * masked-view`) rather than required: without it iOS gets the blur down to
 * the bar's edge and the page-colour fade below it. On Android, a plain
 * gradient of the page colour: its blur came out "dirty".
 */
const { React, h, RN, Reanimated, AnimatedView, BlurView, LinearGradient, useScheme } = require('./runtime');
const {
  HEADER_BAR_HEIGHT,
  HEADER_DEFAULT_THRESHOLD,
  headerThreshold,
  headerBarFade,
  headerTitleFade,
  headerBottomFade,
  headerGradientStops,
  androidHeaderColors
} = require('../logic/collapsibleHeader');

const { interpolate, useAnimatedStyle, useSharedValue } = Reanimated;

/**
 * The scroll of a page and its threshold, for a screen that lays out the
 * header itself.
 *
 * - `onScroll` goes to the page's scroll (with `scrollEventThrottle={16}`);
 *   the scrolling content starts with `paddingTop: topInset +
 *   HEADER_BAR_HEIGHT` (`topInset` = 0 when a safe-area view already pads it).
 * - `onTitleLayout` goes to the `onLayout` of the large title (or the block
 *   holding it), a DIRECT child of the scrolling content.
 * - `onListTitleLayout`: the same block used as a FlatList's
 *   `ListHeaderComponent`, where the measure does not include the top padding.
 * - `measureTitle(node)`: for a title whose position is unknown (nested
 *   views), measured in the window against `originRef`, a view placed at the
 *   top of the scrolling area — both measures in the same frame, whatever the
 *   system.
 */
function useCollapsibleHeader({ topInset = 0 } = {}) {
  const scrollY = useSharedValue(0);
  const threshold = useSharedValue(HEADER_DEFAULT_THRESHOLD);
  const originRef = React.useRef(null);
  const onScroll = React.useCallback(
    (event) => {
      scrollY.value = event.nativeEvent.contentOffset.y;
    },
    [scrollY]
  );
  const placeThreshold = React.useCallback(
    (titleBottom) => {
      threshold.value = headerThreshold(titleBottom, topInset);
    },
    [threshold, topInset]
  );
  const onTitleLayout = React.useCallback(
    (event) => placeThreshold(event.nativeEvent.layout.y + event.nativeEvent.layout.height),
    [placeThreshold]
  );
  const onListTitleLayout = React.useCallback(
    (event) =>
      placeThreshold(topInset + HEADER_BAR_HEIGHT + event.nativeEvent.layout.y + event.nativeEvent.layout.height),
    [placeThreshold, topInset]
  );
  const measureTitle = React.useCallback(
    (node) => {
      const origin = originRef.current;
      if (!node || !origin) return;
      origin.measureInWindow((_x, areaTop) =>
        node.measureInWindow((_x2, y, _w, height) => placeThreshold(y - areaTop + height + scrollY.value))
      );
    },
    [scrollY, placeThreshold]
  );
  return { scrollY, threshold, onScroll, onTitleLayout, onListTitleLayout, measureTitle, originRef };
}

const styles = {
  zone: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  /* Taller than the zone: it overflows below for the fade. */
  background: { position: 'absolute', top: 0, left: 0, right: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  /* Both sides share a minimum width: the title stays centred even with a
     single action on the right. */
  side: { minWidth: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  right: { justifyContent: 'flex-end' },
  center: { flex: 1, alignItems: 'center', paddingHorizontal: 10 },
  title: { fontWeight: '700', fontSize: 16, letterSpacing: -0.2 }
};

function CollapsibleHeader({
  title,
  scrollY,
  threshold,
  leading,
  actions,
  topInset = 0,
  gutter = 16,
  pageBackground,
  titleColor,
  MaskedView,
  scheme: schemeOverride,
  testID
}) {
  const scheme = useScheme(schemeOverride);
  const background = pageBackground || (scheme === 'dark' ? '#000000' : '#ffffff');
  const barHeight = topInset + HEADER_BAR_HEIGHT;
  const fade = headerBottomFade(RN.Platform.OS);
  const stops = headerGradientStops(barHeight, fade);
  const iosBlur = RN.Platform.OS === 'ios';

  const barStyle = useAnimatedStyle(() => {
    const range = headerBarFade(threshold.value);
    return { opacity: interpolate(scrollY.value, range.input, range.output, 'clamp') };
  });
  const titleStyle = useAnimatedStyle(() => {
    const ranges = headerTitleFade(threshold.value);
    return {
      opacity: interpolate(scrollY.value, ranges.opacity.input, ranges.opacity.output, 'clamp'),
      transform: [{ translateY: interpolate(scrollY.value, ranges.translateY.input, ranges.translateY.output, 'clamp') }]
    };
  });

  const blur = h(BlurView, {
    intensity: 80,
    tint: scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight',
    style: MaskedView ? RN.StyleSheet.absoluteFill : { height: barHeight }
  });
  const pageFade = (style) =>
    h(LinearGradient, { colors: androidHeaderColors(background), locations: stops, style });

  let backdrop;
  if (iosBlur && MaskedView) {
    backdrop = h(
      MaskedView,
      {
        style: RN.StyleSheet.absoluteFill,
        maskElement: h(LinearGradient, {
          colors: ['#000000', '#000000', 'rgba(0,0,0,0)'],
          locations: stops,
          style: RN.StyleSheet.absoluteFill
        })
      },
      blur
    );
  } else if (iosBlur) {
    /* No mask available: the blur stops at the bar's edge, and the page
       colour's own fade carries the overflow. */
    backdrop = h(
      RN.View,
      { style: RN.StyleSheet.absoluteFill },
      pageFade(RN.StyleSheet.absoluteFill),
      blur
    );
  } else {
    backdrop = pageFade(RN.StyleSheet.absoluteFill);
  }

  return h(
    RN.View,
    { testID, pointerEvents: 'box-none', style: [styles.zone, { height: barHeight }] },
    h(AnimatedView, { pointerEvents: 'none', style: [styles.background, { height: barHeight + fade }, barStyle] }, backdrop),
    h(
      RN.View,
      {
        pointerEvents: 'box-none',
        style: [styles.row, { marginTop: topInset, height: HEADER_BAR_HEIGHT, paddingHorizontal: gutter }]
      },
      h(RN.View, { style: styles.side }, leading || null),
      h(
        AnimatedView,
        { pointerEvents: 'none', style: [styles.center, titleStyle] },
        h(
          RN.Text,
          {
            numberOfLines: 1,
            accessibilityRole: 'header',
            style: [styles.title, { color: titleColor || (scheme === 'dark' ? '#ffffff' : '#0d1235') }]
          },
          title
        )
      ),
      h(RN.View, { style: [styles.side, styles.right] }, actions || null)
    )
  );
}

/**
 * A scrolling screen with the collapsible header already wired: the large
 * title (`largeTitle`) scrolls, sets the threshold by its own layout, and the
 * header floats above everything.
 */
function CollapsibleScreen({
  title,
  largeTitle,
  children,
  leading,
  actions,
  topInset = 0,
  gutter = 16,
  pageBackground,
  titleColor,
  MaskedView,
  scheme,
  contentContainerStyle,
  scrollProps,
  testID
}) {
  const header = useCollapsibleHeader({ topInset });
  const onScroll = (event) => {
    header.onScroll(event);
    if (scrollProps && scrollProps.onScroll) scrollProps.onScroll(event);
  };
  return h(
    RN.View,
    { testID, style: { flex: 1, backgroundColor: pageBackground } },
    h(RN.View, { ref: header.originRef, collapsable: false }),
    h(
      RN.ScrollView,
      {
        showsVerticalScrollIndicator: false,
        ...scrollProps,
        onScroll,
        scrollEventThrottle: 16,
        /* Under the fixed header: the large title starts below the back button's row. */
        contentContainerStyle: [{ flexGrow: 1, paddingTop: topInset + HEADER_BAR_HEIGHT }, contentContainerStyle]
      },
      largeTitle ? h(RN.View, { style: { paddingHorizontal: gutter }, onLayout: header.onTitleLayout }, largeTitle) : null,
      children
    ),
    h(CollapsibleHeader, {
      title,
      scrollY: header.scrollY,
      threshold: header.threshold,
      leading,
      actions,
      topInset,
      gutter,
      pageBackground,
      titleColor,
      MaskedView,
      scheme
    })
  );
}

module.exports = { useCollapsibleHeader, CollapsibleHeader, CollapsibleScreen };
