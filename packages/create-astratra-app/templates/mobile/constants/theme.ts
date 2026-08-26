/**
 * The one place colours, type and spacing are decided.
 *
 * THE SYSTEM FONT, ON PURPOSE. React Native does not map `fontWeight` onto a
 * bundled font — a custom family needs one file per weight, and a missing one
 * renders silently as regular. The system font honours numeric weights
 * natively, so every weight below must be paired with its number.
 *
 * ONE SURFACE RECIPE. `card` is the translucent panel every component sits on.
 * Defining it once is what keeps a header, a tile and a tab bar looking like
 * the same material rather than three near-misses.
 */
import { Platform } from 'react-native';

const SYSTEM = Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' });

export const fonts = { regular: SYSTEM, medium: SYSTEM, semibold: SYSTEM, bold: SYSTEM, extrabold: SYSTEM };

export const fontWeights = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800'
} as const;

/*
 * TWO TRIPLES DECIDE THE WHOLE IDENTITY.
 *
 * Every shade in this app is derived from them, so changing an application's
 * look is changing these two lines — not hunting fifty-six literals across a
 * dozen components. That hunt is exactly what makes one product's components
 * look like another product.
 */
const INK_RGB = '13,18,53';
const ACCENT_RGB = '61,90,254';

/** `inkAlpha(0.55)` reads better than a copied rgba(), and follows INK_RGB. */
export const inkAlpha = (alpha: number) => `rgba(${INK_RGB},${alpha})`;
export const accentAlpha = (alpha: number) => `rgba(${ACCENT_RGB},${alpha})`;

/* Ink, in three weights. Named by role, not by shade: a component asks for
   "muted", never for "55% of the ink colour". */
export const TEXT = `rgb(${INK_RGB})`;
export const MUTED = inkAlpha(0.55);
export const FAINT = inkAlpha(0.35);

export const colors = {
  /* Deep enough for a translucent surface to read against it. Near-white here
     made every glass panel disappear: the card and the page were the same
     colour, so the login form looked like loose text on a page. */
  background: '#dfe5f3',
  surface: 'rgba(255,255,255,0.82)',
  /* The same surface without transparency, for a device that cannot blur. */
  surfaceOpaque: '#f7f9fe',
  /* Just enough colour over a blur to keep text readable on any wallpaper. */
  veil: 'rgba(255,255,255,0.42)',
  border: 'rgba(255,255,255,0.95)',
  text: TEXT,
  muted: MUTED,
  faint: FAINT,
  accent: `rgb(${ACCENT_RGB})`,
  /* Ink for anything sitting ON the accent. Reusing `text` there puts dark
     ink on a saturated blue — legible enough to pass a screenshot, wrong
     enough to fail a contrast check. */
  onAccent: '#ffffff',
  danger: '#e5484d',
  positive: '#1f9d55',
  /* Opaque white, for anything that must not let the page through. */
  paper: '#ffffff'
};

/** The translucent panel, spread into any surface that should read as glass. */
/**
 * The one surface recipe — and it is platform-split for a reason.
 *
 * The shadow is what separates the panel from the page: a translucent white
 * card on a light background, with only an edge, reads as nothing at all.
 *
 * BUT ANDROID DRAWS ELEVATION AGAINST AN OPAQUE BACKGROUND. Given a
 * translucent one it paints a solid block behind the whole view — a white
 * rectangle inside the card, which is exactly what it looked like. So Android
 * gets an opaque surface and elevation; iOS keeps the translucent surface and
 * the soft shadow it renders properly.
 */
export const card = {
  backgroundColor: colors.surface,
  borderWidth: 1,
  borderColor: colors.border,
  /* iOS only: Android ignores shadow*, and its `elevation` equivalent paints a
     solid rectangle behind a translucent view. Surfaces that need lifting on
     Android use a blur instead — see components/GlassPanel.tsx. */
  ...Platform.select({
    ios: {
      shadowColor: '#18234f',
      shadowOpacity: 0.1,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 10 }
    },
    default: {}
  })
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
