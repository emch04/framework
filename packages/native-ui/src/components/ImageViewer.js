/**
 * Pictures full screen, the way Photos shows them: black around the picture,
 * round glass controls that a tap hides and shows again.
 *
 * - Swipe sideways from one picture to the next.
 * - Pinch to zoom, or double-tap where you want to look closer; double-tap
 *   again to come back. While zoomed, the finger moves around the picture and
 *   the pages stay put.
 * - Pull the picture down to close: the black fades as it goes.
 * - At the top: close, where you are ("3 of 12", the app's words), and the
 *   details when the app gives some.
 * - At the bottom: the title, then what can be done — share (the app's hook),
 *   and the app's own actions (save, remove…). An action may answer with a
 *   short notice ("Saved"), shown a moment over the picture.
 *
 * Zoom is native on iOS (a zooming ScrollView: its bounce, its deceleration).
 * Android's ScrollView does not zoom — the first version simply had no pinch
 * there — so Android gets a pinch of its own: two fingers scale around the
 * point between them, one finger moves the zoomed picture, and on release it
 * settles back inside its bounds (logic/picture.js).
 *
 * Nothing here is worded or fetched: labels, icons, actions and how a picture
 * becomes a source (`resolveSource`, typically @astratra/native's
 * `createPictureSources().resolve`, which alone decides whether a token goes
 * with it) all come from the app. "Reduce Motion": no fades, no springs, no
 * shrinking pull; the viewer opens and closes at once.
 */
const { React, h, RN, Reanimated, AnimatedView, useReducedMotion } = require('./runtime');
const { GlassButton } = require('./GlassButton');
const { GlassSurface } = require('./GlassSurface');
const {
  VIEWER_GESTURES,
  clampIndex,
  clampPan,
  isDoubleTap,
  isPullToClose,
  pageFromOffset,
  pinchTransform,
  pullEffect,
  settleTransform,
  shouldClose,
  touchCentre,
  touchDistance,
  zoomAt,
  zoomRect
} = require('../logic/picture');

const { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } = Reanimated;

/* Always drawn on black: the viewer keeps its own colours whatever the app's
   theme, as Photos does. */
const BLACK = '#000000';
const INK = '#ffffff';
const SOFT = 'rgba(255,255,255,0.72)';
const PULL_BACK = { damping: 20, stiffness: 260, mass: 1 };
const GAP = 12;
const GUTTER = 16;

function haptic(onHaptic, kind) {
  if (typeof onHaptic === 'function') onHaptic(kind);
}

/** Taps told apart: a single tap waits out the double-tap window before counting. */
function useTaps(onSingle, onDouble) {
  const last = React.useRef(0);
  const timer = React.useRef(null);
  const handlers = React.useRef({ onSingle, onDouble });
  handlers.current = { onSingle, onDouble };
  React.useEffect(() => () => clearTimeout(timer.current), []);
  return React.useCallback((point) => {
    const now = Date.now();
    clearTimeout(timer.current);
    timer.current = null;
    if (isDoubleTap(last.current, now)) {
      last.current = 0;
      handlers.current.onDouble(point);
      return;
    }
    last.current = now;
    timer.current = setTimeout(() => {
      timer.current = null;
      handlers.current.onSingle();
    }, VIEWER_GESTURES.doubleTapMs);
  }, []);
}

/** The source of one picture, resolved by the app; a failure is a state, not a spinner forever. */
function usePictureSource(picture, resolveSource) {
  const [state, setState] = React.useState({ source: null, failed: false });
  const resolver = React.useRef(resolveSource);
  resolver.current = resolveSource;
  React.useEffect(() => {
    let live = true;
    setState({ source: null, failed: false });
    Promise.resolve()
      .then(() => (typeof resolver.current === 'function' ? resolver.current(picture) : picture.source))
      .then(
        (source) => {
          if (!live) return;
          setState(source && typeof source.uri === 'string' && source.uri ? { source, failed: false } : { source: null, failed: true });
        },
        () => live && setState({ source: null, failed: true })
      );
    return () => {
      live = false;
    };
    /* A picture is its key: a new object for the same key is the same picture. */
  }, [picture.key]);
  const fail = React.useCallback(() => setState({ source: null, failed: true }), []);
  return { ...state, fail };
}

/** One page: the picture, its zoom, its taps. */
function Page({ picture, width, height, resolveSource, ImageComponent, imageProps, failedIcon, onSingleTap, onZoomChange, reduceMotion, onHaptic, zoomHint }) {
  const { source, failed, fail } = usePictureSource(picture, resolveSource);
  const frame = { width, height };
  const android = RN.Platform.OS === 'android';
  const zoomed = React.useRef(false);
  /* The gesture handlers are made once per frame size: they read the props
     of the moment through this ref, never those of their creation. */
  const live = React.useRef({ reduceMotion, onZoomChange });
  live.current = { reduceMotion, onZoomChange };
  const setZoomed = (next) => {
    if (next === zoomed.current) return;
    zoomed.current = next;
    live.current.onZoomChange(next);
  };

  /* iOS: the ScrollView zooms. */
  const scroll = React.useRef(null);
  /* Android: a transform of our own, driven from the gesture. */
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const current = React.useRef({ scale: 1, x: 0, y: 0 });

  const moveTo = (next, animate) => {
    current.current = next;
    const glide = animate && !live.current.reduceMotion;
    const timing = { duration: 240, easing: Easing.out(Easing.cubic) };
    scale.value = glide ? withTiming(next.scale, timing) : next.scale;
    tx.value = glide ? withTiming(next.x, timing) : next.x;
    ty.value = glide ? withTiming(next.y, timing) : next.y;
    setZoomed(next.scale > 1.01);
  };

  const onDouble = (point) => {
    haptic(onHaptic, 'selection');
    if (android) {
      moveTo(zoomed.current ? { scale: 1, x: 0, y: 0 } : zoomAt(point, frame, VIEWER_GESTURES.zoomIn), true);
      return;
    }
    const target = zoomed.current ? { x: 0, y: 0, width, height } : zoomRect(point, frame, VIEWER_GESTURES.zoomIn);
    if (scroll.current) scroll.current.scrollResponderZoomTo({ ...target, animated: !live.current.reduceMotion });
  };
  const tap = useTaps(onSingleTap, onDouble);

  const gesture = React.useRef({ start: null, pinch: null, moved: false });
  const responder = React.useMemo(
    () =>
      android
        ? RN.PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: (event) => zoomed.current || (event.nativeEvent.touches || []).length >= 2,
            onPanResponderGrant: () => {
              gesture.current = { start: { ...current.current }, pinch: null, moved: false };
            },
            onPanResponderMove: (event, move) => {
              const touches = event.nativeEvent.touches || [];
              const state = gesture.current;
              if (Math.abs(move.dx) > VIEWER_GESTURES.tapSlop || Math.abs(move.dy) > VIEWER_GESTURES.tapSlop) state.moved = true;
              if (touches.length >= 2) {
                state.moved = true;
                if (!state.pinch) {
                  state.pinch = { ...current.current, distance: touchDistance(touches), focus: touchCentre(touches) };
                }
                moveTo(pinchTransform(state.pinch, touchDistance(touches), touchCentre(touches), frame), false);
              } else if (current.current.scale > 1.01 && !state.pinch) {
                const pan = clampPan({ x: state.start.x + move.dx, y: state.start.y + move.dy }, current.current.scale, frame);
                moveTo({ scale: current.current.scale, x: pan.x, y: pan.y }, false);
              }
            },
            onPanResponderRelease: (event) => {
              const state = gesture.current;
              if (!state.moved) {
                tap({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY });
                return;
              }
              moveTo(settleTransform(current.current, frame), true);
            },
            /* Not zoomed, the list may take a sideways swipe; zoomed, the finger is ours. */
            onPanResponderTerminationRequest: () => current.current.scale <= 1.01,
            onPanResponderTerminate: () => moveTo(settleTransform(current.current, frame), true)
          })
        : null,
    // The frame is read through `frame` at each gesture; a rotation re-creates the page.
    [android, width, height]
  );

  const transform = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }]
  }));

  const label = picture.accessibilityLabel || picture.title;
  const body = failed
    ? failedIcon || null
    : source
      ? h(ImageComponent || RN.Image, {
          ...(ImageComponent && ImageComponent !== RN.Image ? { contentFit: 'contain' } : { resizeMode: 'contain' }),
          ...(imageProps || {}),
          source,
          style: { width, height },
          onError: fail,
          accessibilityIgnoresInvertColors: true
        })
      : h(RN.ActivityIndicator, { color: SOFT });

  const a11y = { accessible: true, accessibilityRole: 'image', accessibilityLabel: label, accessibilityHint: zoomHint };

  if (android) {
    return h(
      RN.View,
      { style: { width, height, overflow: 'hidden' }, testID: `page-${picture.key}` },
      h(
        AnimatedView,
        { ...responder.panHandlers, ...a11y, style: [{ width, height, alignItems: 'center', justifyContent: 'center' }, transform] },
        body
      )
    );
  }

  return h(
    RN.ScrollView,
    {
      ref: scroll,
      testID: `page-${picture.key}`,
      style: { width, height },
      contentContainerStyle: { width, height },
      maximumZoomScale: VIEWER_GESTURES.maxZoom,
      minimumZoomScale: 1,
      bouncesZoom: !reduceMotion,
      centerContent: true,
      scrollEventThrottle: 32,
      onScroll: (event) => setZoomed((event.nativeEvent.zoomScale || 1) > 1.01),
      showsHorizontalScrollIndicator: false,
      showsVerticalScrollIndicator: false
    },
    h(
      RN.Pressable,
      {
        ...a11y,
        onPress: (event) => tap({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }),
        style: { width, height, alignItems: 'center', justifyContent: 'center' }
      },
      body
    )
  );
}

/** A round glass control on black. */
function Control({ icon, label, onPress, busy, disabled, testID }) {
  return h(
    GlassButton,
    { accessibilityLabel: label, onPress, size: 44, scheme: 'dark', disabled: Boolean(busy || disabled), testID },
    busy ? h(RN.ActivityIndicator, { color: INK }) : icon
  );
}

function ImageViewer({
  pictures,
  start,
  onClose,
  onIndexChange,
  resolveSource,
  ImageComponent,
  imageProps,
  labels = {},
  icons = {},
  onShare,
  actions,
  onActionError,
  renderDetails,
  insets,
  onHaptic,
  testID
}) {
  const list = Array.isArray(pictures) ? pictures : [];
  const { width, height } = RN.useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const open = start !== null && start !== undefined && list.length > 0;
  const top = (insets && insets.top) || 0;
  const bottom = (insets && insets.bottom) || 0;

  const [index, setIndex] = React.useState(0);
  const [chrome, setChrome] = React.useState(true);
  const [details, setDetails] = React.useState(false);
  const [zoomed, setZoomed] = React.useState(false);
  const [busy, setBusy] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const pull = useSharedValue(0);
  const shown = useSharedValue(1);
  const listRef = React.useRef(null);
  const mounted = React.useRef(true);
  React.useEffect(
    () => () => {
      mounted.current = false;
    },
    []
  );

  const at = Math.min(index, Math.max(0, list.length - 1));
  const picture = open ? list[at] : null;

  /* Opened on a picture: that one, controls shown, nothing pulled. */
  React.useEffect(() => {
    if (start === null || start === undefined) return;
    setIndex(clampIndex(start, list.length) ?? 0);
    setChrome(true);
    setDetails(false);
    setZoomed(false);
    setNotice(null);
    pull.value = 0;
    // Only a new opening resets; the list changing under an open viewer does not.
  }, [start]);

  React.useEffect(() => {
    shown.value = reduceMotion ? (chrome ? 1 : 0) : withTiming(chrome ? 1 : 0, { duration: VIEWER_GESTURES.chromeFadeMs });
  }, [chrome, reduceMotion, shown]);

  React.useEffect(() => {
    if (!notice) return undefined;
    if (RN.AccessibilityInfo && typeof RN.AccessibilityInfo.announceForAccessibility === 'function') {
      RN.AccessibilityInfo.announceForAccessibility(notice);
    }
    const timer = setTimeout(() => setNotice(null), VIEWER_GESTURES.noticeMs);
    return () => clearTimeout(timer);
  }, [notice]);

  /* The last picture removed while open: nothing left to show. */
  const wasOpen = start !== null && start !== undefined;
  React.useEffect(() => {
    if (wasOpen && list.length === 0 && typeof onClose === 'function') onClose();
  }, [wasOpen, list.length, onClose]);

  /* A rotation changes the page width: the list is put back on the same picture. */
  const lastWidth = React.useRef(width);
  React.useEffect(() => {
    if (lastWidth.current === width) return;
    lastWidth.current = width;
    if (open && listRef.current && typeof listRef.current.scrollToIndex === 'function') {
      listRef.current.scrollToIndex({ index: at, animated: false });
    }
  }, [width, open, at]);

  const latest = React.useRef({ zoomed, onClose, reduceMotion, height, onHaptic });
  latest.current = { zoomed, onClose, reduceMotion, height, onHaptic };

  const close = React.useCallback(() => {
    if (typeof latest.current.onClose === 'function') latest.current.onClose();
  }, []);

  const dismiss = React.useMemo(
    () =>
      RN.PanResponder.create({
        /* One finger, downward, not zoomed: a pull. Two fingers are a pinch. */
        onMoveShouldSetPanResponderCapture: (event, gesture) => {
          const touches = (event && event.nativeEvent && event.nativeEvent.touches) || [];
          return touches.length < 2 && isPullToClose(gesture, latest.current.zoomed);
        },
        onPanResponderMove: (_, gesture) => {
          pull.value = Math.max(0, gesture.dy);
        },
        onPanResponderRelease: (_, gesture) => {
          const { reduceMotion: still, height: screen } = latest.current;
          if (shouldClose(gesture)) {
            haptic(latest.current.onHaptic, 'impact');
            if (still) {
              pull.value = 0;
              close();
              return;
            }
            pull.value = withTiming(screen, { duration: VIEWER_GESTURES.closeMs }, (finished) => {
              if (finished) runOnJS(close)();
            });
          } else {
            pull.value = still ? 0 : withSpring(0, PULL_BACK);
          }
        },
        onPanResponderTerminate: () => {
          pull.value = latest.current.reduceMotion ? 0 : withSpring(0, PULL_BACK);
        }
      }),
    [pull, close]
  );

  const backdrop = useAnimatedStyle(() => ({ opacity: pullEffect(pull.value, height, reduceMotion).backdrop }));
  const carried = useAnimatedStyle(() => ({
    transform: [{ translateY: pull.value }, { scale: pullEffect(pull.value, height, reduceMotion).scale }]
  }));
  const chromeStyle = useAnimatedStyle(() => ({ opacity: shown.value * pullEffect(pull.value, height, reduceMotion).backdrop }));

  const run = async (key, handler) => {
    if (!picture || busy) return;
    setBusy(key);
    try {
      const result = await handler(picture);
      if (typeof result === 'string' && result) {
        haptic(onHaptic, 'success');
        if (mounted.current) setNotice(result);
      }
    } catch (error) {
      haptic(onHaptic, 'failure');
      if (typeof onActionError === 'function') onActionError(error, key, picture);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const allActions = [
    ...(typeof onShare === 'function' && icons.share ? [{ key: 'share', label: labels.share, icon: icons.share, onPress: onShare }] : []),
    ...(Array.isArray(actions) ? actions.filter((action) => action && action.key && typeof action.onPress === 'function') : [])
  ];
  const canDetail = typeof renderDetails === 'function' && icons.details;
  const hiddenFromReaders = chrome ? {} : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' };

  return h(
    RN.Modal,
    {
      visible: open,
      transparent: true,
      animationType: reduceMotion ? 'none' : 'fade',
      onRequestClose: onClose,
      statusBarTranslucent: true,
      supportedOrientations: ['portrait', 'landscape']
    },
    h(RN.StatusBar, { hidden: open && !chrome, barStyle: 'light-content', animated: !reduceMotion }),
    h(
      RN.View,
      { testID, style: { flex: 1 }, accessibilityViewIsModal: true, onAccessibilityEscape: onClose },
      h(AnimatedView, { pointerEvents: 'none', style: [RN.StyleSheet.absoluteFill, { backgroundColor: BLACK }, backdrop] }),
      h(
        AnimatedView,
        { ...dismiss.panHandlers, style: [{ flex: 1 }, carried] },
        open
          ? h(RN.FlatList, {
              ref: listRef,
              data: list,
              keyExtractor: (item) => String(item.key),
              horizontal: true,
              pagingEnabled: true,
              scrollEnabled: !zoomed,
              initialScrollIndex: clampIndex(start, list.length) ?? 0,
              getItemLayout: (_, position) => ({ length: width, offset: width * position, index: position }),
              showsHorizontalScrollIndicator: false,
              onMomentumScrollEnd: (event) => {
                const next = pageFromOffset(event.nativeEvent.contentOffset.x, width, list.length);
                if (next === at) return;
                setIndex(next);
                setDetails(false);
                haptic(onHaptic, 'selection');
                if (typeof onIndexChange === 'function') onIndexChange(next);
              },
              renderItem: ({ item }) =>
                h(Page, {
                  picture: item,
                  width,
                  height,
                  resolveSource,
                  ImageComponent,
                  imageProps,
                  failedIcon: icons.failed,
                  zoomHint: labels.zoomHint,
                  reduceMotion,
                  onHaptic,
                  onZoomChange: setZoomed,
                  onSingleTap: () => {
                    setChrome((visible) => !visible);
                    setDetails(false);
                  }
                })
            })
          : null
      ),
      picture
        ? [
            /* The top: close, where you are, the details. */
            h(
              AnimatedView,
              {
                key: 'top',
                ...hiddenFromReaders,
                pointerEvents: chrome ? 'box-none' : 'none',
                style: [
                  { position: 'absolute', top: top + 8, left: GUTTER, right: GUTTER, flexDirection: 'row', alignItems: 'center' },
                  chromeStyle
                ]
              },
              h(Control, { icon: icons.close, label: labels.close, onPress: onClose, testID: 'viewer-close' }),
              h(
                RN.View,
                { style: { flex: 1, alignItems: 'center' } },
                list.length > 1 && typeof labels.counter === 'function'
                  ? h(
                      GlassSurface,
                      { scheme: 'dark', style: { borderRadius: 999 } },
                      h(
                        RN.Text,
                        {
                          style: {
                            color: INK,
                            fontSize: 13,
                            fontWeight: '600',
                            fontVariant: ['tabular-nums'],
                            paddingHorizontal: 12,
                            paddingVertical: 6
                          }
                        },
                        labels.counter(at + 1, list.length)
                      )
                    )
                  : null
              ),
              canDetail
                ? h(Control, {
                    icon: details && icons.detailsActive ? icons.detailsActive : icons.details,
                    label: labels.details,
                    onPress: () => setDetails((visible) => !visible),
                    testID: 'viewer-details'
                  })
                : h(RN.View, { style: { width: 44 } })
            ),
            /* The bottom: the details when asked, else the title; then what can be done. */
            h(
              AnimatedView,
              {
                key: 'bottom',
                ...hiddenFromReaders,
                pointerEvents: chrome ? 'box-none' : 'none',
                style: [{ position: 'absolute', left: GUTTER, right: GUTTER, bottom: bottom + GAP, gap: GAP }, chromeStyle]
              },
              details && canDetail
                ? h(
                    GlassSurface,
                    { scheme: 'dark', style: { borderRadius: 24 } },
                    h(RN.ScrollView, { style: { maxHeight: height * 0.3 }, contentContainerStyle: { padding: GUTTER, gap: 8 } }, renderDetails(picture))
                  )
                : picture.title
                  ? h(
                      RN.Text,
                      {
                        numberOfLines: 2,
                        style: {
                          color: INK,
                          fontSize: 17,
                          fontWeight: '600',
                          textAlign: 'center',
                          textShadowColor: 'rgba(0,0,0,0.6)',
                          textShadowRadius: 8
                        }
                      },
                      picture.title
                    )
                  : null,
              allActions.length
                ? h(
                    RN.View,
                    { style: { flexDirection: 'row', justifyContent: 'center', gap: GUTTER } },
                    allActions.map((action) =>
                      h(Control, {
                        key: action.key,
                        icon: action.icon,
                        label: action.label,
                        busy: busy === action.key,
                        disabled: busy !== null && busy !== action.key,
                        onPress: () => void run(action.key, action.onPress),
                        testID: `viewer-action-${action.key}`
                      })
                    )
                  )
                : null
            ),
            notice
              ? h(
                  RN.View,
                  {
                    key: 'notice',
                    pointerEvents: 'none',
                    accessibilityLiveRegion: 'polite',
                    style: { position: 'absolute', top: height / 2 - 40, left: 0, right: 0, alignItems: 'center' }
                  },
                  h(
                    GlassSurface,
                    { scheme: 'dark', style: { borderRadius: 24 } },
                    h(
                      RN.View,
                      { style: { alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingVertical: GUTTER } },
                      icons.notice || null,
                      h(RN.Text, { style: { color: INK, fontSize: 15, fontWeight: '600' } }, notice)
                    )
                  )
                )
              : null
          ]
        : null
    )
  );
}

module.exports = { ImageViewer };
