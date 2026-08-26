/**
 * How much glass this device can actually render.
 *
 * The first version of this said "iOS or an imitation", which was wrong and
 * gave every Android app a flat plate where iOS got a translucent surface.
 * Android renders a REAL backdrop blur — it simply needs to be asked for
 * explicitly, and the ask is different from iOS's.
 *
 * So there are three answers, not two:
 *
 *   'native'   — the platform's own glass material (iOS 26+ glass effect API);
 *   'blur'     — a real backdrop blur (expo-blur, iOS AND Android);
 *   'fallback' — no blur available: a translucent layer, honestly flat.
 *
 * Deciding it once, from facts the caller reports, keeps every surface of the
 * app in agreement — a header that blurs above a card that does not is worse
 * than neither blurring.
 *
 * `apiAvailable` and `effectAvailable` stay separate: the module can be
 * installed (API present) while the OS is too old for the effect itself.
 */
function resolveGlassMode({ platform, apiAvailable, effectAvailable, blurAvailable } = {}) {
  if (platform === 'ios' && Boolean(apiAvailable) && Boolean(effectAvailable)) return 'native';
  if (blurAvailable) return 'blur';
  return 'fallback';
}

/**
 * What to pass expo-blur so the blur is real on this platform.
 *
 * Android needs `experimentalBlurMethod: 'dimezisBlurView'`. Without it the
 * BlurView renders as a plain translucent overlay — it looks like the fallback
 * while claiming to be a blur, which is the worst of the three states because
 * nobody notices it is wrong.
 */
function blurPropsFor(platform, intensity = 40) {
  return {
    intensity,
    tint: 'light',
    ...(platform === 'android' ? { experimentalBlurMethod: 'dimezisBlurView' } : {})
  };
}

module.exports = { resolveGlassMode, blurPropsFor };
