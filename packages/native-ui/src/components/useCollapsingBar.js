/**
 * Wires a screen's scroll to the folding of its floating bars.
 *
 * The screen passes `onScroll` to its list (with `scrollEventThrottle={16}`)
 * and `collapse` to `TabBar` / `FloatingPagination`. `collapse` goes from 0
 * (full) to 1 (folded); it glides on a spring, on the UI thread, without
 * re-rendering the screen. With "Reduce motion" on, the bar does not move at
 * all. The decision itself is `followScroll`, tested dry.
 */
const { React, Reanimated, useReducedMotion } = require('./runtime');
const { followScroll, INITIAL_COLLAPSE, COLLAPSED_SCALE, COLLAPSED_DROP } = require('../logic/collapse');

/* Destructured once: a worklet must capture `interpolate` itself (a worklet),
   never the whole module object. */
const { interpolate, useAnimatedStyle, useSharedValue, withSpring } = Reanimated;

const SPRING = { damping: 22, stiffness: 240, mass: 0.8 };

function useCollapsingBar() {
  const collapse = useSharedValue(0);
  const state = React.useRef(INITIAL_COLLAPSE);
  const reduceMotion = useReducedMotion();

  const onScroll = React.useCallback(
    (event) => {
      if (reduceMotion) return;
      const next = followScroll(state.current, event.nativeEvent.contentOffset.y);
      if (next.collapsed !== state.current.collapsed) {
        collapse.value = withSpring(next.collapsed ? 1 : 0, SPRING);
      }
      state.current = next;
    },
    [reduceMotion, collapse]
  );

  return { collapse, onScroll };
}

/**
 * The fold itself, shared by every floating bar so they fold alike: toward
 * the bottom, to COLLAPSED_SCALE. Without a `collapse` value wired, the bar
 * simply stays full. Pair it with `transformOrigin: 'bottom'`.
 */
function useCollapseTransform(collapse) {
  const resting = useSharedValue(0);
  const progress = collapse || resting;
  return useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(progress.value, [0, 1], [0, COLLAPSED_DROP]) },
      { scale: interpolate(progress.value, [0, 1], [1, COLLAPSED_SCALE]) }
    ]
  }));
}

module.exports = { useCollapsingBar, useCollapseTransform };
