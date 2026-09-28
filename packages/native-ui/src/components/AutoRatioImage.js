/**
 * A picture free on the page, in its own proportions: no frame around it, its
 * corners rounded, nothing cut off. Until it is known it holds a place (a
 * square by default, or the shape the app expects) where a soft light passes;
 * once there, it takes its own shape and comes up gently — from a hair smaller
 * and transparent — rather than all at once. "Reduce Motion": at once.
 *
 * The source is given ready (`source`), or fetched (`load`, with a
 * `sourceKey` naming the picture) — typically `@astratra/native`'s
 * `createPictureSources().resolve`, which decides whether the person's token
 * goes with it. This component never builds an address nor adds a header.
 *
 * A failure — a load that rejects, a picture that does not decode — leaves the
 * place with the app's error slot (`renderError({ retry })`); nothing spins
 * forever.
 *
 * The image component is injected: React Native's Image by default, or
 * expo-image's (`ImageComponent={Image}` with its caching props in
 * `imageProps`). Both load events are read.
 */
const { React, h, RN, Reanimated, AnimatedView, useReducedMotion, useScheme } = require('./runtime');
const { ImageShimmer } = require('./ImageShimmer');
const { PICTURE_REVEAL, naturalRatio, loadedSize, revealStyle } = require('../logic/picture');
const { PALE_CARD_RADIUS } = require('../logic/paleCard');

const { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } = Reanimated;

/* The surface shown only while the picture is not there (loading, failed). */
const DEFAULT_SURFACE = { light: '#eef0f5', dark: '#1c1c1e' };

/* The press, like the kit's glass button: the finger sinks the picture on a
   spring without bounce, the release brings it back with a hair of overshoot. */
const PRESSED_SCALE = 0.98;
const PRESS_IN = { stiffness: 600, damping: 2 * Math.sqrt(600), mass: 1 };
const RELEASE = { stiffness: 380, damping: 20, mass: 1 };

function AutoRatioImage({
  source,
  load,
  sourceKey,
  ImageComponent,
  imageProps,
  fit = 'contain',
  initialRatio = 1,
  minRatio,
  maxRatio,
  borderRadius = PALE_CARD_RADIUS,
  surfaceColor,
  placeholder,
  loadingLabel,
  renderError,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  onLongPress,
  onLoad,
  onError,
  onRatio,
  revealMs = PICTURE_REVEAL.durationMs,
  scheme: schemeOverride,
  style,
  testID
}) {
  const scheme = useScheme(schemeOverride);
  const reduceMotion = useReducedMotion();
  const Picture = ImageComponent || RN.Image;
  const limits = { min: minRatio, max: maxRatio };
  const startRatio = naturalRatio(null, { fallback: initialRatio, ...limits });
  const key = sourceKey !== undefined && sourceKey !== null ? String(sourceKey) : source && source.uri ? source.uri : null;

  const [resolved, setResolved] = React.useState(null);
  const [phase, setPhase] = React.useState('resolving');
  const [ratio, setRatio] = React.useState(startRatio);
  const [attempt, setAttempt] = React.useState(0);
  const shown = useSharedValue(0);
  const press = useSharedValue(0);

  /* A new picture starts over: its own place, its own reveal. The first
     version kept the previous picture's shape and failure. */
  const latest = React.useRef({ load, source, onError });
  latest.current = { load, source, onError };
  React.useEffect(() => {
    let live = true;
    shown.value = 0;
    setRatio(startRatio);
    setResolved(null);
    const fail = (error) => {
      if (!live) return;
      setPhase('failed');
      if (latest.current.onError) latest.current.onError(error);
    };
    if (typeof latest.current.load === 'function') {
      setPhase('resolving');
      Promise.resolve()
        .then(() => latest.current.load())
        .then((next) => {
          if (!live) return;
          if (next && typeof next.uri === 'string' && next.uri) {
            setResolved(next);
            setPhase('loading');
          } else {
            fail(null);
          }
        }, fail);
    } else if (latest.current.source && latest.current.source.uri) {
      setResolved(latest.current.source);
      setPhase('loading');
    } else {
      setPhase('failed');
    }
    return () => {
      live = false;
    };
    /* The picture is named by its key: a new object for the same key is the
       same picture, and must not start the reveal over. */
  }, [key, attempt]);

  const retry = React.useCallback(() => setAttempt((count) => count + 1), []);

  const handleLoad = (event) => {
    const size = loadedSize(event);
    if (size) {
      const next = naturalRatio(size, { fallback: initialRatio, ...limits });
      setRatio(next);
      if (onRatio) onRatio(next);
    }
    shown.value = reduceMotion ? 1 : withTiming(1, { duration: revealMs, easing: Easing.out(Easing.cubic) });
    setPhase('loaded');
    if (onLoad) onLoad(size);
  };

  const handleError = (event) => {
    setPhase('failed');
    if (onError) onError(event && event.nativeEvent ? event.nativeEvent.error : event);
  };

  const reveal = useAnimatedStyle(() => revealStyle(shown.value));
  const pressed = useAnimatedStyle(() => ({
    transform: [{ scale: reduceMotion ? 1 : 1 - (1 - PRESSED_SCALE) * press.value }],
    opacity: reduceMotion ? 1 - 0.25 * press.value : 1
  }));

  const loaded = phase === 'loaded';
  const failed = phase === 'failed';
  const surface = surfaceColor || DEFAULT_SURFACE[scheme];
  const fitProps = Picture === RN.Image ? { resizeMode: fit } : { contentFit: fit };

  const waiting =
    placeholder !== undefined
      ? placeholder
      : h(ImageShimmer, {
          ratio,
          borderRadius: 0,
          colors: { base: surface },
          accessibilityLabel: loadingLabel,
          scheme,
          style: RN.StyleSheet.absoluteFill
        });

  const content = failed
    ? h(
        RN.View,
        { style: [RN.StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }] },
        typeof renderError === 'function' ? renderError({ retry }) : null
      )
    : [
        loaded ? null : h(React.Fragment, { key: 'waiting' }, waiting),
        resolved
          ? h(
              AnimatedView,
              { key: `picture-${attempt}`, pointerEvents: 'none', style: [RN.StyleSheet.absoluteFill, reveal] },
              h(Picture, {
                ...fitProps,
                ...(imageProps || {}),
                source: resolved,
                onLoad: handleLoad,
                onError: handleError,
                accessibilityIgnoresInvertColors: true,
                style: { width: '100%', height: '100%' }
              })
            )
          : null
      ];

  const frame = {
    aspectRatio: ratio,
    borderRadius,
    overflow: 'hidden',
    backgroundColor: loaded ? 'transparent' : surface
  };

  if (typeof onPress !== 'function' && typeof onLongPress !== 'function') {
    return h(
      RN.View,
      {
        testID,
        /* Failed, the frame stops grouping: the app's retry button inside
           must be reachable by the screen reader on its own. */
        accessible: !failed,
        accessibilityRole: 'image',
        accessibilityLabel,
        accessibilityState: { busy: !loaded && !failed },
        style: [frame, style]
      },
      content
    );
  }

  return h(
    AnimatedView,
    { style: [pressed, style] },
    h(
      RN.Pressable,
      {
        testID,
        accessible: !failed,
        accessibilityRole: 'imagebutton',
        accessibilityLabel,
        accessibilityHint,
        accessibilityState: { disabled: !loaded, busy: !loaded && !failed },
        disabled: !loaded,
        onPress,
        onLongPress,
        onPressIn: () => {
          press.value = withSpring(1, PRESS_IN);
        },
        onPressOut: () => {
          press.value = withSpring(0, RELEASE);
        },
        style: frame
      },
      content
    )
  );
}

module.exports = { AutoRatioImage };
