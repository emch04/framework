const {
  PICTURE_RATIO_LIMITS,
  PICTURE_REVEAL,
  SHIMMER_PASS_MS,
  VIEWER_GESTURES,
  PICTURES_ARRIVING_EMPTY,
  naturalRatio,
  loadedSize,
  revealStyle,
  shimmerTranslate,
  isDoubleTap,
  zoomRect,
  panLimits,
  clampPan,
  zoomAt,
  touchDistance,
  touchCentre,
  pinchTransform,
  settleTransform,
  isPullToClose,
  shouldClose,
  pullEffect,
  clampIndex,
  pageFromOffset,
  reducePicturesArriving,
  picturesArrivingCount,
  countRunningSteps
} = require('../src/logic');

const FRAME = { width: 400, height: 800 };

describe('naturalRatio', () => {
  test('the picture\'s own proportions once known', () => {
    expect(naturalRatio({ width: 1600, height: 900 })).toBeCloseTo(16 / 9);
    expect(naturalRatio({ width: 900, height: 1600 })).toBeCloseTo(9 / 16);
  });

  test('the fallback until then, and for a size that is not one', () => {
    expect(naturalRatio(null)).toBe(1);
    expect(naturalRatio({ width: 0, height: 100 }, { fallback: 4 / 3 })).toBeCloseTo(4 / 3);
    expect(naturalRatio({ width: 100, height: 0 })).toBe(1);
    expect(naturalRatio({ width: -5, height: 10 })).toBe(1);
    expect(naturalRatio({ width: 'x', height: 10 })).toBe(1);
    expect(naturalRatio(undefined, { fallback: -1 })).toBe(1);
  });

  test('bounded: a strip does not make a view ten thousand points tall', () => {
    expect(naturalRatio({ width: 1, height: 10000 })).toBe(PICTURE_RATIO_LIMITS.min);
    expect(naturalRatio({ width: 10000, height: 1 })).toBe(PICTURE_RATIO_LIMITS.max);
    expect(naturalRatio({ width: 1, height: 10 }, { min: 0.05 })).toBeCloseTo(0.1);
    expect(naturalRatio({ width: 10, height: 1 }, { max: 3 })).toBe(3);
    expect(naturalRatio({ width: 10, height: 1 }, { min: 2, max: 1 })).toBe(PICTURE_RATIO_LIMITS.max);
  });
});

describe('loadedSize', () => {
  test('expo-image\'s event and React Native\'s', () => {
    expect(loadedSize({ source: { width: 30, height: 20 } })).toEqual({ width: 30, height: 20 });
    expect(loadedSize({ nativeEvent: { source: { width: 30, height: 20 } } })).toEqual({ width: 30, height: 20 });
    expect(loadedSize({ nativeEvent: { width: 30, height: 20 } })).toEqual({ width: 30, height: 20 });
  });

  test('null without a size', () => {
    expect(loadedSize(undefined)).toBeNull();
    expect(loadedSize({ source: { width: 0, height: 20 } })).toBeNull();
    expect(loadedSize({ nativeEvent: {} })).toBeNull();
  });
});

describe('reveal and shimmer', () => {
  test('the reveal goes from a hair smaller and transparent to its place', () => {
    expect(revealStyle(0)).toEqual({ opacity: 0, transform: [{ scale: PICTURE_REVEAL.fromScale }] });
    expect(revealStyle(1)).toEqual({ opacity: 1, transform: [{ scale: 1 }] });
    expect(revealStyle(0.5).transform[0].scale).toBeCloseTo(0.98);
    expect(revealStyle(7)).toEqual(revealStyle(1));
    expect(revealStyle(-1)).toEqual(revealStyle(0));
    expect(revealStyle('x')).toEqual(revealStyle(0));
    expect(PICTURE_REVEAL.durationMs).toBe(700);
  });

  test('the light crosses from off the left edge to off the right', () => {
    expect(shimmerTranslate(0)).toBe('-100%');
    expect(shimmerTranslate(0.5)).toBe('0%');
    expect(shimmerTranslate(1)).toBe('100%');
    expect(shimmerTranslate(2)).toBe('100%');
    expect(SHIMMER_PASS_MS).toBe(1600);
  });
});

describe('viewer taps and zoom', () => {
  test('a double tap is two taps inside the window', () => {
    expect(isDoubleTap(1000, 1200)).toBe(true);
    expect(isDoubleTap(1000, 1000 + VIEWER_GESTURES.doubleTapMs)).toBe(false);
    expect(isDoubleTap(0, 100)).toBe(false);
    expect(isDoubleTap(null, 100)).toBe(false);
    expect(isDoubleTap(1000, 900)).toBe(false);
    expect(isDoubleTap(1000, 1100, 50)).toBe(false);
  });

  test('the zoom rectangle centres the tap and stays inside the frame', () => {
    expect(zoomRect({ x: 200, y: 400 }, FRAME, 2)).toEqual({ x: 100, y: 200, width: 200, height: 400 });
    expect(zoomRect({ x: 0, y: 0 }, FRAME, 2)).toEqual({ x: 0, y: 0, width: 200, height: 400 });
    expect(zoomRect({ x: 400, y: 800 }, FRAME, 2)).toEqual({ x: 200, y: 400, width: 200, height: 400 });
    expect(zoomRect({ x: 10, y: 10 }, FRAME, 0.5)).toEqual({ x: 0, y: 0, width: 400, height: 800 });
  });

  test('pan limits: the enlarged edges stay on the frame\'s edges', () => {
    expect(panLimits(2, FRAME)).toEqual({ x: 200, y: 400 });
    expect(panLimits(0.5, FRAME)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: 500, y: -900 }, 2, FRAME)).toEqual({ x: 200, y: -400 });
    expect(clampPan({ x: 'x', y: 10 }, 1, FRAME)).toEqual({ x: 0, y: 0 });
  });

  test('zooming at a point keeps that point under the finger, clamped at the edges', () => {
    const centre = zoomAt({ x: 200, y: 400 }, FRAME, 2.5);
    expect(centre).toEqual({ scale: 2.5, x: 0, y: 0 });
    const off = zoomAt({ x: 300, y: 400 }, FRAME, 2);
    /* The point maps to c + t + s(p - c) = 200 - 100 + 2 * 100 = 300: where it was. */
    expect(200 + off.x + off.scale * (300 - 200)).toBe(300);
    const corner = zoomAt({ x: 0, y: 0 }, FRAME, 4);
    expect(corner.x).toBe(panLimits(4, FRAME).x);
    expect(corner.y).toBe(panLimits(4, FRAME).y);
    expect(zoomAt({ x: 0, y: 0 }, FRAME, 0.3).scale).toBe(1);
  });

  test('touch distance and centre', () => {
    const touches = [{ pageX: 0, pageY: 0 }, { pageX: 30, pageY: 40 }];
    expect(touchDistance(touches)).toBe(50);
    expect(touchDistance([touches[0]])).toBe(0);
    expect(touchDistance(null)).toBe(0);
    expect(touchCentre(touches)).toEqual({ x: 15, y: 20 });
    expect(touchCentre([touches[1]])).toEqual({ x: 30, y: 40 });
    expect(touchCentre([])).toEqual({ x: 0, y: 0 });
  });

  test('a pinch scales with the spread, and the point under the fingers follows them', () => {
    const start = { scale: 1, x: 0, y: 0, distance: 100, focus: { x: 300, y: 500 } };
    const doubled = pinchTransform(start, 200, { x: 300, y: 500 }, FRAME);
    expect(doubled.scale).toBe(2);
    /* The focus point stays put: c + t + s * q = focus, with q = focus - c at the start. */
    expect(200 + doubled.x + 2 * (300 - 200)).toBeCloseTo(300);
    expect(400 + doubled.y + 2 * (500 - 400)).toBeCloseTo(500);
    const moved = pinchTransform(start, 200, { x: 320, y: 480 }, FRAME);
    expect(200 + moved.x + 2 * 100).toBeCloseTo(320);
  });

  test('a pinch may overshoot the bounds a little, then settles inside them', () => {
    const start = { scale: 1, x: 0, y: 0, distance: 100, focus: { x: 200, y: 400 } };
    expect(pinchTransform(start, 10000, { x: 200, y: 400 }, FRAME).scale).toBeCloseTo(VIEWER_GESTURES.maxZoom * 1.15);
    expect(pinchTransform(start, 1, { x: 200, y: 400 }, FRAME).scale).toBeCloseTo(1 / 1.15);
    expect(pinchTransform({ ...start, distance: 0 }, 50, { x: 200, y: 400 }, FRAME).scale).toBe(1);
    expect(settleTransform({ scale: 9, x: 5000, y: 0 }, FRAME)).toEqual({ scale: 4, x: 600, y: 0 });
    expect(settleTransform({ scale: 0.7, x: 40, y: 40 }, FRAME)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(settleTransform({ scale: 1.0005, x: 3, y: 3 }, FRAME)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(settleTransform({ scale: 2, x: 50, y: -30 }, FRAME)).toEqual({ scale: 2, x: 50, y: -30 });
  });
});

describe('viewer pull to close', () => {
  test('a pull starts downward, clearly vertical, never while zoomed', () => {
    expect(isPullToClose({ dx: 0, dy: 20 }, false)).toBe(true);
    expect(isPullToClose({ dx: 0, dy: 20 }, true)).toBe(false);
    expect(isPullToClose({ dx: 0, dy: VIEWER_GESTURES.pullSlop }, false)).toBe(false);
    expect(isPullToClose({ dx: 0, dy: -30 }, false)).toBe(false);
    expect(isPullToClose({ dx: 20, dy: 20 }, false)).toBe(false);
    expect(isPullToClose({ dx: 10, dy: 16 }, false)).toBe(true);
  });

  test('a released pull closes far enough or fast enough', () => {
    expect(shouldClose({ dy: 121, vy: 0 })).toBe(true);
    expect(shouldClose({ dy: 120, vy: 0 })).toBe(false);
    expect(shouldClose({ dy: 20, vy: 1 })).toBe(true);
    expect(shouldClose({ dy: 20, vy: 0.9 })).toBe(false);
  });

  test('the black fades over half the screen, the picture shrinks to 80 %, not with Reduce Motion', () => {
    expect(pullEffect(0, 800)).toEqual({ backdrop: 1, scale: 1 });
    expect(pullEffect(200, 800)).toEqual({ backdrop: 0.5, scale: 0.95 });
    expect(pullEffect(800, 800)).toEqual({ backdrop: 0, scale: 0.8 });
    expect(pullEffect(5000, 800).scale).toBe(0.8);
    expect(pullEffect(200, 800, true)).toEqual({ backdrop: 0.5, scale: 1 });
    expect(pullEffect(-50, 800)).toEqual({ backdrop: 1, scale: 1 });
    expect(pullEffect(10, 0).backdrop).toBe(0);
  });

  test('indexes stay inside the list', () => {
    expect(clampIndex(null, 3)).toBeNull();
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-2, 3)).toBe(0);
    expect(clampIndex(1, 0)).toBeNull();
    expect(pageFromOffset(790, 400, 5)).toBe(2);
    expect(pageFromOffset(99999, 400, 5)).toBe(4);
    expect(pageFromOffset(-10, 400, 5)).toBe(0);
    expect(pageFromOffset(10, 0, 5)).toBe(0);
  });
});

describe('pictures arriving', () => {
  const play = (events, state = PICTURES_ARRIVING_EMPTY) => events.reduce(reducePicturesArriving, state);

  test('a place per picture on its way, a repeat counted once', () => {
    const state = play([
      { type: 'started', id: 'a' },
      { type: 'started', id: 'b' },
      { type: 'started', id: 'a' }
    ]);
    expect(picturesArrivingCount(state)).toBe(2);
  });

  test('a finished job KEEPS its place until the picture arrives (the source dropped it at once)', () => {
    const finished = play([{ type: 'started', id: 'a' }, { type: 'finished', id: 'a', ok: true }]);
    expect(picturesArrivingCount(finished)).toBe(1);
    expect(finished.slots[0].state).toBe('ready');
    expect(picturesArrivingCount(play([{ type: 'arrived', id: 'a' }], finished))).toBe(0);
  });

  test('a failure frees the place at once', () => {
    expect(picturesArrivingCount(play([{ type: 'started', id: 'a' }, { type: 'finished', id: 'a', ok: false }]))).toBe(0);
  });

  test('a picture arriving without an id takes the oldest finished place, else the oldest', () => {
    const state = play([
      { type: 'started', id: 'a' },
      { type: 'started', id: 'b' },
      { type: 'finished', id: 'b', ok: true },
      { type: 'arrived' }
    ]);
    expect(state.slots.map((slot) => slot.id)).toEqual(['a']);
    expect(play([{ type: 'arrived' }], state).slots).toEqual([]);
    expect(play([{ type: 'started', id: 'a' }, { type: 'started', id: 'b' }, { type: 'arrived' }]).slots.map((s) => s.id)).toEqual(['b']);
  });

  test('the end of the stream, or a new turn, clears every place', () => {
    const state = play([{ type: 'started', id: 'a' }, { type: 'finished', id: 'a', ok: true }]);
    expect(play([{ type: 'ended' }], state)).toBe(PICTURES_ARRIVING_EMPTY);
    expect(play([{ type: 'reset' }], state)).toBe(PICTURES_ARRIVING_EMPTY);
  });

  test('an event that changes nothing returns the SAME state (React skips the render)', () => {
    const state = play([{ type: 'started', id: 'a' }, { type: 'finished', id: 'a', ok: true }]);
    expect(reducePicturesArriving(state, { type: 'started', id: 'a' })).toBe(state);
    expect(reducePicturesArriving(state, { type: 'finished', id: 'a', ok: true })).toBe(state);
    expect(reducePicturesArriving(state, { type: 'finished', id: 'zz', ok: false })).toBe(state);
    expect(reducePicturesArriving(state, { type: 'arrived', id: 'zz' })).toBe(state);
    expect(reducePicturesArriving(state, { type: 'unknown' })).toBe(state);
    expect(reducePicturesArriving(state, null)).toBe(state);
    expect(reducePicturesArriving(state, { type: 'started', id: '' })).toBe(state);
    expect(reducePicturesArriving(PICTURES_ARRIVING_EMPTY, { type: 'arrived' })).toBe(PICTURES_ARRIVING_EMPTY);
    expect(reducePicturesArriving(PICTURES_ARRIVING_EMPTY, { type: 'ended' })).toBe(PICTURES_ARRIVING_EMPTY);
  });

  test('a missing state starts empty; the state is never mutated', () => {
    expect(picturesArrivingCount(reducePicturesArriving(undefined, { type: 'started', id: 'a' }))).toBe(1);
    const state = play([{ type: 'started', id: 'a' }]);
    const frozen = JSON.stringify(state);
    play([{ type: 'finished', id: 'a', ok: true }, { type: 'arrived', id: 'a' }], state);
    expect(JSON.stringify(state)).toBe(frozen);
    expect(picturesArrivingCount(null)).toBe(0);
  });

  test('counted from steps: the running steps of the tool, as the source did', () => {
    const steps = [
      { tool: 'draw', state: 'running' },
      { tool: 'draw', state: 'ok' },
      { tool: 'draw', state: 'failed' },
      { tool: 'read', state: 'running' },
      { tool: 'sketch', state: 'running' }
    ];
    expect(countRunningSteps(steps, 'draw')).toBe(1);
    expect(countRunningSteps(steps, ['draw', 'sketch'])).toBe(2);
    expect(countRunningSteps(null, 'draw')).toBe(0);
    expect(countRunningSteps([null], 'draw')).toBe(0);
  });
});
