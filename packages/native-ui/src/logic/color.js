/**
 * Colour arithmetic, without a colour library.
 *
 * Every surface of the kit mixes a tint into a page colour, or re-weights the
 * alpha of a tint. Doing it here, on plain strings, is what lets a test check
 * the result to the digit instead of judging a screenshot.
 */

/**
 * Reads `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()`.
 * Returns `{ r, g, b, a }`, or null for anything else (a named colour, a
 * typo) — the caller decides what an unreadable colour falls back to.
 */
function parseColor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) {
    const [r, g, b] = [short[1], short[2], short[3]].map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/.exec(v);
  if (long) {
    const [r, g, b] = [long[1], long[2], long[3]].map((c) => parseInt(c, 16));
    return { r, g, b, a: long[4] ? parseInt(long[4], 16) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (fn) {
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
  }
  return null;
}

function toHex({ r, g, b }) {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/**
 * `tint` laid over `background` at `proportion`, returned OPAQUE.
 *
 * Opaque on purpose: a page often paints a pattern (a grid, a gradient) under
 * its content, and a translucent card lets that pattern show through as a
 * faint checkerboard. The alpha of either input is ignored.
 */
function mixColors(background, tint, proportion) {
  const base = parseColor(background) || { r: 255, g: 255, b: 255 };
  const colour = parseColor(tint) || base;
  return toHex({
    r: base.r + (colour.r - base.r) * proportion,
    g: base.g + (colour.g - base.g) * proportion,
    b: base.b + (colour.b - base.b) * proportion
  });
}

/** The same colour at another alpha, whatever notation it came in. */
function withAlpha(color, alpha) {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${c.r},${c.g},${c.b},${Number(alpha.toFixed(3))})`;
}

module.exports = { parseColor, mixColors, withAlpha };
