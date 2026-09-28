/**
 * The rules behind the picture components: a picture's own shape, how it
 * comes up, the light that passes while it is being made, the gestures of the
 * full-screen viewer, and the count of pictures still on their way.
 *
 * Pure — no react-native — so every threshold is tested in plain Node, and a
 * component only renders what these functions decide.
 */

/* The functions an animated style calls (revealStyle, shimmerTranslate,
   pullEffect) carry the 'worklet' directive: they run on the UI thread, where
   only worklets can. In Node the directive is an inert string. */

/* ─────────────────────────────── Shape ─────────────────────────────── */

/**
 * The limits of a picture's shape on the page. A 1×10 000 strip must not make
 * a view ten thousand points tall, nor a panorama a line one point high: past
 * these ratios the picture is shown whole ('contain') inside the bounded box.
 */
const PICTURE_RATIO_LIMITS = Object.freeze({ min: 0.2, max: 5 });

/**
 * The width/height ratio to lay a picture out at: its own once known, the
 * fallback until then (and for a size that is not one).
 *
 * @param {{width?: number, height?: number} | null | undefined} size
 * @param {object} [options]
 * @param {number} [options.fallback=1]  A square until the picture is known.
 * @param {number} [options.min]
 * @param {number} [options.max]
 */
function naturalRatio(size, options = {}) {
  const min = Number.isFinite(options.min) && options.min > 0 ? options.min : PICTURE_RATIO_LIMITS.min;
  const max = Number.isFinite(options.max) && options.max >= min ? options.max : PICTURE_RATIO_LIMITS.max;
  const fallback = Number.isFinite(options.fallback) && options.fallback > 0 ? options.fallback : 1;
  const width = size ? Number(size.width) : NaN;
  const height = size ? Number(size.height) : NaN;
  const ratio = width > 0 && height > 0 && Number.isFinite(width / height) ? width / height : fallback;
  return Math.min(max, Math.max(min, ratio));
}

/**
 * The picture's size from a load event, whichever image component sent it:
 * expo-image (`{ source: { width, height } }`) or React Native's Image
 * (`{ nativeEvent: { source: { width, height } } }`). Null when absent.
 */
function loadedSize(event) {
  const candidates = [
    event && event.source,
    event && event.nativeEvent && event.nativeEvent.source,
    event && event.nativeEvent
  ];
  for (const candidate of candidates) {
    if (candidate && Number(candidate.width) > 0 && Number(candidate.height) > 0) {
      return { width: Number(candidate.width), height: Number(candidate.height) };
    }
  }
  return null;
}

/* ─────────────────────────────── Reveal ────────────────────────────── */

/**
 * How a picture comes up once it is there: from a hair smaller and
 * transparent to its place, on an ease-out — not all at once. With "Reduce
 * Motion", at once.
 */
const PICTURE_REVEAL = Object.freeze({ durationMs: 700, fromScale: 0.96 });

/** The reveal at `progress` (0 → 1), clamped. */
function revealStyle(progress, reveal = PICTURE_REVEAL) {
  'worklet';
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  return { opacity: p, transform: [{ scale: reveal.fromScale + (1 - reveal.fromScale) * p }] };
}

/* ─────────────────────────────── Shimmer ───────────────────────────── */

/** One pass of the light across the placeholder, left to right. */
const SHIMMER_PASS_MS = 1600;

/** Where the light is at `progress` (0 → 1): from a full width off the left edge to a full width off the right. */
function shimmerTranslate(progress) {
  'worklet';
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  return `${-100 + p * 200}%`;
}

/* ─────────────────────────────── Viewer ────────────────────────────── */

/**
 * The viewer's gesture thresholds, as Photos behaves:
 * - two taps closer than `doubleTapMs` zoom (a single tap waits that long
 *   before toggling the controls, so the two are told apart);
 * - a double tap zooms to `zoomIn`, a pinch goes up to `maxZoom`;
 * - a pull down closes past `closeDistance` points, or faster than
 *   `closeSpeed` points per millisecond;
 * - a move is a pull only once it is `pullSlop` points down and clearly more
 *   vertical than horizontal (`pullSlant`) — a sideways swipe stays a page turn.
 */
const VIEWER_GESTURES = Object.freeze({
  doubleTapMs: 260,
  zoomIn: 2.5,
  maxZoom: 4,
  closeDistance: 120,
  closeSpeed: 0.9,
  pullSlop: 10,
  pullSlant: 1.5,
  /* Under this movement, a release is a tap. */
  tapSlop: 8,
  /* How long the controls take to fade, and the "done" notice stays. */
  chromeFadeMs: 180,
  noticeMs: 1800,
  closeMs: 180
});

/** Whether a tap at `now` is the second of a double tap. */
function isDoubleTap(previousAt, now, windowMs = VIEWER_GESTURES.doubleTapMs) {
  return Number.isFinite(previousAt) && previousAt > 0 && now - previousAt >= 0 && now - previousAt < windowMs;
}

/**
 * The rectangle to zoom into so that `point` ends up in the middle, kept
 * inside the frame: a double tap near an edge zooms the edge, it does not
 * scroll past it into black.
 *
 * @param {{x: number, y: number}} point  In the frame's coordinates.
 * @param {{width: number, height: number}} frame
 * @param {number} zoom  > 1.
 */
function zoomRect(point, frame, zoom = VIEWER_GESTURES.zoomIn) {
  const scale = Math.max(1, Number(zoom) || 1);
  const width = frame.width / scale;
  const height = frame.height / scale;
  const x = Math.min(frame.width - width, Math.max(0, point.x - width / 2));
  const y = Math.min(frame.height - height, Math.max(0, point.y - height / 2));
  return { x, y, width, height };
}

/**
 * The furthest a picture zoomed to `scale` may move: its enlarged edges stay
 * on the frame's edges, never inside them.
 */
function panLimits(scale, frame) {
  const s = Math.max(1, scale);
  return { x: ((s - 1) * frame.width) / 2, y: ((s - 1) * frame.height) / 2 };
}

/** A translation kept within the limits of `scale`. */
function clampPan(translation, scale, frame) {
  const limit = panLimits(scale, frame);
  const clamp = (value, bound) => Math.min(bound, Math.max(-bound, Number(value) || 0));
  return { x: clamp(translation.x, limit.x), y: clamp(translation.y, limit.y) };
}

/**
 * The transform that zooms to `scale` around `point` — the point under the
 * finger stays under the finger — clamped to the frame. The transform is
 * `translate` THEN `scale`, around the frame's centre (React Native's order).
 *
 * @param {{x: number, y: number}} point  In the frame's coordinates.
 * @param {{width: number, height: number}} frame
 * @param {number} scale
 * @returns {{scale: number, x: number, y: number}}
 */
function zoomAt(point, frame, scale) {
  const s = Math.max(1, scale);
  const centre = { x: frame.width / 2, y: frame.height / 2 };
  const pan = clampPan({ x: -(point.x - centre.x) * (s - 1), y: -(point.y - centre.y) * (s - 1) }, s, frame);
  return { scale: s, x: pan.x, y: pan.y };
}

/** The distance between the first two touches, or 0 with fewer. */
function touchDistance(touches) {
  if (!Array.isArray(touches) || touches.length < 2) return 0;
  const [a, b] = touches;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

/** The point between the first two touches (the pinch's focus), or the only one. */
function touchCentre(touches) {
  if (!Array.isArray(touches) || touches.length === 0) return { x: 0, y: 0 };
  if (touches.length === 1) return { x: touches[0].pageX, y: touches[0].pageY };
  return { x: (touches[0].pageX + touches[1].pageX) / 2, y: (touches[0].pageY + touches[1].pageY) / 2 };
}

/**
 * The transform during a pinch: the scale grows with the fingers' spread, and
 * the point that was under the fingers at the start follows them.
 *
 * @param {object} start  `{ scale, x, y, distance, focus: {x, y} }` when the second finger came down.
 * @param {number} distance  The fingers' spread now.
 * @param {{x: number, y: number}} focus  Between the fingers now.
 * @param {{width: number, height: number}} frame  Its centre is the transform's origin.
 * @param {object} [limits]  `{ min = 1, max = maxZoom, overshoot = 1.15 }`: a
 *   pinch may go a little past the bounds (it springs back on release).
 */
function pinchTransform(start, distance, focus, frame, limits = {}) {
  const min = limits.min ?? 1;
  const max = limits.max ?? VIEWER_GESTURES.maxZoom;
  const overshoot = limits.overshoot ?? 1.15;
  const raw = start.distance > 0 ? (start.scale * distance) / start.distance : start.scale;
  const scale = Math.min(max * overshoot, Math.max(min / overshoot, raw));
  const centre = { x: frame.width / 2, y: frame.height / 2 };
  /* The picture point under the fingers at the start, in unscaled coordinates. */
  const anchor = {
    x: (start.focus.x - centre.x - start.x) / start.scale,
    y: (start.focus.y - centre.y - start.y) / start.scale
  };
  return { scale, x: focus.x - centre.x - scale * anchor.x, y: focus.y - centre.y - scale * anchor.y };
}

/** Where a transform settles once the fingers lift: within the bounds, the edges on the frame. */
function settleTransform(transform, frame, limits = {}) {
  const min = limits.min ?? 1;
  const max = limits.max ?? VIEWER_GESTURES.maxZoom;
  const scale = Math.min(max, Math.max(min, transform.scale));
  if (scale <= 1.001) return { scale: 1, x: 0, y: 0 };
  const pan = clampPan(transform, scale, frame);
  return { scale, x: pan.x, y: pan.y };
}

/**
 * Whether a move is the start of a pull to close: not while zoomed (the
 * finger then moves around the picture), downward, and clearly vertical.
 * @param {{dx: number, dy: number}} gesture
 */
function isPullToClose(gesture, zoomed, rules = VIEWER_GESTURES) {
  if (zoomed) return false;
  return gesture.dy > rules.pullSlop && Math.abs(gesture.dy) > Math.abs(gesture.dx) * rules.pullSlant;
}

/** Whether a released pull closes the viewer: far enough, or fast enough. */
function shouldClose(gesture, rules = VIEWER_GESTURES) {
  return gesture.dy > rules.closeDistance || gesture.vy > rules.closeSpeed;
}

/**
 * What a pull does to the viewer: the black fades by half the screen, the
 * picture shrinks to 80 % over the whole screen. "Reduce Motion": it only
 * fades — nothing shrinks.
 */
function pullEffect(pull, height, reduceMotion = false) {
  'worklet';
  const h = Math.max(1, Number(height) || 1);
  const p = Math.max(0, Number(pull) || 0);
  return {
    backdrop: Math.max(0, 1 - p / (h * 0.5)),
    scale: reduceMotion ? 1 : Math.max(0.8, 1 - (0.2 * p) / h)
  };
}

/** The index to open on, inside the list (null stays null: closed). */
function clampIndex(index, count) {
  if (index === null || index === undefined || !(count > 0)) return null;
  return Math.min(count - 1, Math.max(0, Math.round(Number(index) || 0)));
}

/** The page a horizontal list rests on, from its offset. */
function pageFromOffset(offset, width, count) {
  if (!(width > 0) || !(count > 0)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(offset / width)));
}

/* ────────────────────────── Pictures arriving ──────────────────────── */

/**
 * The pictures still on their way (being drawn, generated, uploaded), each a
 * place held on screen until the picture itself takes it.
 *
 * The first version counted the running "draw" steps of an agent. The count
 * fell to zero as soon as the step finished — while the picture itself came
 * in a later event: the placeholder vanished, the text below jumped up, and
 * the picture then pushed it down again. Here a finished job keeps its place
 * until the picture ARRIVES; only a failure, or the end of the stream, gives
 * it back.
 *
 * Events:
 * - `{ type: 'started', id }`      a picture is on its way (a repeat is ignored);
 * - `{ type: 'finished', id, ok }` its job ended: ok keeps the place until the
 *                                   picture arrives, a failure frees it;
 * - `{ type: 'arrived', id? }`     the picture is here: its place goes. Without
 *                                   an id, the oldest finished place goes (else
 *                                   the oldest place);
 * - `{ type: 'ended' }`            the stream is over: nothing else will come;
 * - `{ type: 'reset' }`            a new turn.
 *
 * The state is `{ slots: [{ id, state: 'working'|'ready' }] }`; the same object
 * comes back when an event changes nothing (React skips the render).
 */
const PICTURES_ARRIVING_EMPTY = Object.freeze({ slots: Object.freeze([]) });

function reducePicturesArriving(state, event) {
  const current = state && Array.isArray(state.slots) ? state : PICTURES_ARRIVING_EMPTY;
  if (!event || typeof event.type !== 'string') return current;
  const slots = current.slots;
  switch (event.type) {
    case 'started':
      if (typeof event.id !== 'string' || !event.id || slots.some((slot) => slot.id === event.id)) return current;
      return { slots: [...slots, { id: event.id, state: 'working' }] };
    case 'finished': {
      const at = slots.findIndex((slot) => slot.id === event.id);
      if (at === -1) return current;
      if (event.ok === false) return { slots: slots.filter((_, index) => index !== at) };
      if (slots[at].state === 'ready') return current;
      return { slots: slots.map((slot, index) => (index === at ? { ...slot, state: 'ready' } : slot)) };
    }
    case 'arrived': {
      let at = typeof event.id === 'string' ? slots.findIndex((slot) => slot.id === event.id) : -1;
      if (at === -1 && typeof event.id !== 'string') {
        at = slots.findIndex((slot) => slot.state === 'ready');
        if (at === -1) at = 0;
      }
      if (at === -1 || slots.length === 0) return current;
      return { slots: slots.filter((_, index) => index !== at) };
    }
    case 'ended':
    case 'reset':
      return slots.length === 0 ? current : PICTURES_ARRIVING_EMPTY;
    default:
      return current;
  }
}

/** How many places to hold. */
function picturesArrivingCount(state) {
  return state && Array.isArray(state.slots) ? state.slots.length : 0;
}

/**
 * The same count read straight from a list of steps, for an app that keeps
 * steps rather than events: the steps of `tool` still running.
 * @param {ReadonlyArray<{tool: string, state: string}>} steps
 * @param {string|readonly string[]} tool
 */
function countRunningSteps(steps, tool) {
  const tools = Array.isArray(tool) ? tool : [tool];
  return (Array.isArray(steps) ? steps : []).filter((step) => step && tools.includes(step.tool) && step.state === 'running').length;
}

module.exports = {
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
};
