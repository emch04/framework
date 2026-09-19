/**
 * The floating tab bar, Instagram style.
 *
 * A round floating bar, sober destinations — an icon and a short label — and
 * an optional centre tab, raised, for the app's signature action. On iOS the
 * bar is the Dock's glass; Android keeps a light card (its system has no such
 * material, and its imitations came out grey).
 *
 * Four behaviours, each asked for after seeing the previous version on a
 * phone:
 *  - the ACTIVE TAB is full ink on a grey pill, not a blue accent;
 *  - the pill SLIDES to the tapped tab, and the page opens once it has almost
 *    arrived — opening in the same frame covered the bar, the slide was never
 *    seen;
 *  - the CENTRE TAB never takes the pill: it opens, the pill stays where it
 *    was (it is an action more than a place);
 *  - the bar FOLDS on scroll (`collapse`, from `useCollapsingBar`) and GROWS a
 *    little on large screens (`barScale`) — never smaller.
 *
 * The geometry is in logic/tabBar.js and logic/collapse.js, tested dry.
 */
const { React, h, RN, Reanimated, AnimatedView, AnimatedText, GlassEffect, getGlassMode, useScheme, useReducedMotion } =
  require('./runtime');
const { GlassSurface } = require('./GlassSurface');
const { useCollapseTransform } = require('./useCollapsingBar');
const { barScale } = require('../logic/collapse');
const {
  TAB_BAR_HEIGHT,
  TAB_ROW_MARGIN,
  TAB_PILL_HEIGHT,
  TAB_CENTER_SIZE,
  TAB_OPEN_DELAY,
  arrangeTabs,
  tabCellWidth,
  pillOffset,
  tabBarWidth,
  badgeText,
  tabAccessibilityLabel
} = require('../logic/tabBar');
const { floatingBottomOffset } = require('../logic/collapse');

const { interpolate, useAnimatedStyle, useSharedValue, withSpring } = Reanimated;

/* On glass the background is never guaranteed: the idle ink is frank on both
   sides of the theme, not a mid grey that gets lost in both. */
const DEFAULT_COLORS = {
  light: { active: '#0d1235', idle: '#343a52', pill: 'rgba(13,18,53,0.08)', badge: '#e5484d', badgeRing: '#fdfdff' },
  dark: { active: '#ffffff', idle: 'rgba(255,255,255,0.9)', pill: 'rgba(255,255,255,0.16)', badge: '#e5484d', badgeRing: '#1c1c1e' }
};
/* A quick spring, without a marked bounce. */
const SLIDE = { damping: 20, stiffness: 260, mass: 0.7 };

const styles = {
  wrapper: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  /* A card, not glass: frank light fill, a hairline, a soft shadow. The bar
     carries the content; it does not make a show. */
  card: {
    backgroundColor: '#fdfdff',
    borderWidth: RN.StyleSheet.hairlineWidth,
    borderColor: 'rgba(13,18,53,0.06)',
    shadowColor: '#18234f',
    shadowOpacity: 0.14,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10
  },
  darkCard: { backgroundColor: '#1c1c1e', borderColor: 'rgba(255,255,255,0.08)' },
  /* The Dock's glass: no fill, no stroke, no shadow — each gave back the
     white slab the glass replaced. The clipping keeps the rounding. */
  glass: { overflow: 'hidden' },
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: TAB_ROW_MARGIN },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  iconStack: { minWidth: 30, height: 24, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: -5,
    right: -9,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5
  },
  badgeText: { color: '#ffffff', fontWeight: '700', fontSize: 9 },
  label: { fontWeight: '500', letterSpacing: 0.1 },
  labelActive: { fontWeight: '600' },
  centerSlot: { flex: 1 },
  centerWrap: { position: 'absolute', alignItems: 'center', gap: 3 }
};

/** Without a navigation focus hook, the bar re-syncs whenever the callback changes. */
function useEffectOnChange(callback) {
  React.useEffect(() => callback(), [callback]);
}

function TabBar({
  tabs,
  activeKey,
  onSelect,
  centerKey,
  renderCenter,
  collapse,
  bottomInset = 0,
  onHaptic,
  openDelay = TAB_OPEN_DELAY,
  useFocusEffect = useEffectOnChange,
  colors,
  scheme: schemeOverride,
  testID
}) {
  const { width: screenWidth } = RN.useWindowDimensions();
  const scheme = useScheme(schemeOverride);
  const palette = { ...DEFAULT_COLORS[scheme], ...(colors || {}) };
  const scale = barScale(screenWidth);
  const height = TAB_BAR_HEIGHT * scale;
  const pillHeight = TAB_PILL_HEIGHT * scale;
  const { ordered, centerIndex } = arrangeTabs(tabs, centerKey);
  const progress = useSharedValue(0);
  const fold = collapse || progress;
  const foldStyle = useCollapseTransform(collapse);
  const reduceMotion = useReducedMotion();
  const glass = getGlassMode() === 'native';

  /* The chosen tab lives here: a tap moves it at once, the pill slides, then
     the page opens. Back on the screen, it becomes the screen's tab again
     (activeKey) and the pill returns there. */
  const [chosen, setChosen] = React.useState(activeKey);
  const [rowWidth, setRowWidth] = React.useState(0);
  const cellWidth = tabCellWidth(rowWidth, ordered.length);
  const keys = ordered.map((tab) => tab.key).join('|');
  const x = useSharedValue(0);
  const place = React.useCallback(
    (key, animated) => {
      const target = pillOffset(keys.split('|'), key, cellWidth);
      x.value = animated && !reduceMotion ? withSpring(target, SLIDE) : target;
    },
    [keys, cellWidth, reduceMotion, x]
  );
  /* First measure (or a rotation): the pill lands without sliding. Only a
     width change re-places it; `chosen` slides through the tap. */
  React.useEffect(() => {
    place(chosen, false);
  }, [cellWidth]); // deliberately not `chosen`: a tap slides the pill itself
  useFocusEffect(
    React.useCallback(() => {
      if (activeKey === centerKey) return;
      setChosen(activeKey);
      place(activeKey, true);
    }, [activeKey, centerKey, place])
  );
  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  const haptic = () => {
    if (onHaptic) onHaptic();
  };
  const select = (tab, active) => {
    if (active) {
      onSelect(tab);
      return;
    }
    haptic();
    /* The centre tab never takes the pill: it opens at once, the pill stays. */
    if (tab.key === centerKey) {
      onSelect(tab);
      return;
    }
    setChosen(tab.key);
    place(tab.key, true);
    if (reduceMotion || !(openDelay > 0)) onSelect(tab);
    else setTimeout(() => onSelect(tab), openDelay);
  };

  return h(
    AnimatedView,
    {
      testID,
      pointerEvents: 'box-none',
      style: [styles.wrapper, { bottom: floatingBottomOffset(bottomInset), transformOrigin: 'bottom' }, foldStyle]
    },
    h(
      RN.View,
      {
        style: [
          glass ? styles.glass : [styles.card, scheme === 'dark' ? styles.darkCard : null],
          { width: tabBarWidth(screenWidth, scale), height, borderRadius: height / 2 }
        ]
      },
      glass
        ? h(GlassEffect.GlassView, {
            glassEffectStyle: 'regular',
            /* A tint in the glass, or the page's coloured cards show through
               the bar and the labels vanish — glaring in dark mode. `clear`
               glass let them scramble the labels; `regular` blurs them
               enough to read, without becoming a card again. */
            tintColor: scheme === 'dark' ? 'rgba(0,0,0,0.62)' : 'rgba(255,255,255,0.42)',
            /* The APP's theme, not the phone's. */
            colorScheme: scheme,
            style: RN.StyleSheet.absoluteFill
          })
        : null,
      h(
        RN.View,
        { style: styles.row, onLayout: (event) => setRowWidth(event.nativeEvent.layout.width) },
        cellWidth > 0
          ? h(AnimatedView, {
              pointerEvents: 'none',
              style: [
                {
                  position: 'absolute',
                  left: 0,
                  width: cellWidth,
                  top: (height - pillHeight) / 2,
                  height: pillHeight,
                  borderRadius: pillHeight / 2,
                  backgroundColor: palette.pill
                },
                pillStyle
              ]
            })
          : null,
        ordered.map((tab, index) =>
          index === centerIndex
            ? h(RN.View, { key: tab.key, style: styles.centerSlot })
            : h(TabItem, {
                key: tab.key,
                tab,
                active: tab.key === chosen,
                onSelect: select,
                scale,
                fold,
                palette,
                testID: testID ? `${testID}-${tab.key}` : undefined
              })
        )
      )
    ),
    centerIndex >= 0
      ? h(CenterTab, {
          tab: ordered[centerIndex],
          onSelect: select,
          fold,
          scale,
          palette,
          renderCenter,
          testID: testID ? `${testID}-${ordered[centerIndex].key}` : undefined
        })
      : null
  );
}

/** The press feedback of a tab: it sinks a little, on a spring. */
function usePressScale(to) {
  const press = React.useRef(new RN.Animated.Value(0)).current;
  const animate = (toValue) =>
    RN.Animated.spring(press, { toValue, friction: 7, tension: 115, useNativeDriver: true }).start();
  const style = { transform: [{ scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, to] }) }] };
  return { style, pressIn: () => animate(1), pressOut: () => animate(0) };
}

function TabItem({ tab, active, onSelect, scale, fold, palette, testID }) {
  const press = usePressScale(0.94);
  const color = active ? palette.active : palette.idle;
  /* Folded: the label fades and the icon drops into its place. */
  const labelStyle = useAnimatedStyle(() => ({ opacity: interpolate(fold.value, [0, 0.6], [1, 0], 'clamp') }));
  const iconStyle = useAnimatedStyle(() => ({ transform: [{ translateY: interpolate(fold.value, [0, 1], [0, 7]) }] }));
  const size = 20 * scale;

  return h(
    RN.Animated.View,
    { style: [{ flex: 1 }, press.style] },
    h(
      RN.Pressable,
      {
        testID,
        accessibilityRole: 'tab',
        accessibilityState: { selected: active },
        accessibilityLabel: tabAccessibilityLabel(tab),
        onPress: () => onSelect(tab, active),
        onPressIn: press.pressIn,
        onPressOut: press.pressOut,
        style: [styles.tab, { minHeight: (TAB_BAR_HEIGHT - 8) * scale }]
      },
      h(
        AnimatedView,
        { style: [styles.iconStack, iconStyle] },
        typeof tab.icon === 'function' ? tab.icon({ color, size, strokeWidth: active ? 2.4 : 2.1, active }) : null,
        tab.badge
          ? h(
              RN.View,
              { style: [styles.badge, { backgroundColor: palette.badge, borderColor: palette.badgeRing }] },
              h(RN.Text, { style: styles.badgeText }, badgeText(tab.badge))
            )
          : null
      ),
      h(
        AnimatedText,
        { numberOfLines: 1, style: [styles.label, { color, fontSize: 10 * scale }, active ? styles.labelActive : null, labelStyle] },
        tab.label
      )
    )
  );
}

/** The centre tab: round, raised above the bar; it never takes the pill, it opens. */
function CenterTab({ tab, onSelect, fold, scale, palette, renderCenter, testID }) {
  const size = TAB_CENTER_SIZE * scale;
  const press = usePressScale(0.92);
  const labelStyle = useAnimatedStyle(() => ({ opacity: interpolate(fold.value, [0, 0.6], [1, 0], 'clamp') }));
  const content = renderCenter
    ? renderCenter({ tab, size })
    : h(
        GlassSurface,
        {
          interactive: true,
          style: { width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }
        },
        typeof tab.icon === 'function' ? tab.icon({ color: palette.active, size: size * 0.44, strokeWidth: 2.2, active: false }) : null
      );
  return h(
    RN.Animated.View,
    { pointerEvents: 'box-none', style: [styles.centerWrap, { top: -size / 2 + 6 }, press.style] },
    h(
      RN.Pressable,
      {
        testID,
        accessibilityRole: 'tab',
        accessibilityState: { selected: false },
        accessibilityLabel: tabAccessibilityLabel(tab),
        onPress: () => onSelect(tab, false),
        onPressIn: press.pressIn,
        onPressOut: press.pressOut,
        style: { padding: 4, borderRadius: (size + 8) / 2 }
      },
      content
    ),
    h(
      AnimatedText,
      { numberOfLines: 1, style: [styles.label, { color: palette.idle, fontSize: 10 * scale, marginTop: 1 }, labelStyle] },
      tab.label
    )
  );
}

module.exports = { TabBar };
