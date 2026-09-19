/**
 * @astratra/native-ui/logic — the pure rules of the kit, without react-native.
 */
import type { GlassMode } from '@astratra/native';

export type { GlassMode };
export type ColorScheme = 'light' | 'dark';

/* ─────────────────────────────── Colour ─────────────────────────────── */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`; null for anything else. */
export function parseColor(value: unknown): Rgba | null;
/** `tint` over `background` at `proportion`, returned as an OPAQUE `#rrggbb`. */
export function mixColors(background: string, tint: string, proportion: number): string;
/** The same colour at another alpha, as `rgba()`; unreadable colours come back unchanged. */
export function withAlpha(color: string, alpha: number): string;

/* ──────────────────────────────── Glass ─────────────────────────────── */

/** The share of a container tint that Apple's glass really shows (0.25). */
export const TINT_WEIGHT: number;
/** The frost of Apple's interactive glass (0.4). */
export const INTERACTIVE_FROST: number;
/** Style keys that draw a shadow on either platform. */
export const SHADOW_KEYS: readonly string[];

/** A translucent tint at Apple's real weight; opaque colours are left alone. */
export function tintAtAppleWeight(color: string, interactive: boolean): string;
/** A flattened style with iOS's shadow rule applied: containers lose their shadow. */
export function surfaceStyleOffApple<T extends object>(flatStyle: T | null | undefined, interactive: boolean): Partial<T>;
/** The default tint of an untinted glass button. */
export function glassButtonTint(input?: { mode?: GlassMode; selected?: boolean }): string;

export interface GlassButtonMaterial {
  glassStyle: 'regular' | 'clear';
  /** Top highlight, clear middle, denser foot. */
  highlight: [string, string, string];
  /** Content glow — Apple's glass only. */
  glow: {
    shadowColor: string;
    shadowOpacity: number;
    shadowRadius: number;
    shadowOffset: { width: number; height: number };
  } | null;
}

export function glassButtonMaterial(input?: { mode?: GlassMode; scheme?: ColorScheme; tinted?: boolean }): GlassButtonMaterial;

/* ────────────────────────────── Pale card ───────────────────────────── */

export const PALE_CARD_RADIUS: number;

export interface PaleCardDose {
  readonly top: number;
  readonly fill: number;
  readonly bottom: number;
}

export const PALE_CARD_DOSAGE: {
  readonly light: { readonly tinted: PaleCardDose; readonly neutral: PaleCardDose };
  readonly dark: { readonly tinted: PaleCardDose; readonly neutral: PaleCardDose };
};

export interface PaleCardColors {
  fill: string;
  top: string;
  bottom: string;
}

export function paleCardColors(input: {
  scheme?: ColorScheme;
  pageBackground: string;
  ink: string;
  tint?: string | null;
}): PaleCardColors;

/* ────────────────────────── Collapse on scroll ──────────────────────── */

export interface CollapseState {
  collapsed: boolean;
  anchor: number;
}

export const COLLAPSE_THRESHOLD: number;
export const TOP_ZONE: number;
export const INITIAL_COLLAPSE: Readonly<CollapseState>;
/** One step of the fold decision; returns the same object when nothing changes. */
export function followScroll(state: CollapseState, y: number): CollapseState;

export const REFERENCE_WIDTH: number;
export const MAX_BAR_SCALE: number;
/** 1 up to a 390-point screen, growing with the width, capped at MAX_BAR_SCALE. */
export function barScale(screenWidth: number | undefined): number;
export const COLLAPSED_SCALE: number;
export const COLLAPSED_DROP: number;
/** Distance of a floating bottom element from the bottom edge. */
export function floatingBottomOffset(bottomInset: number | undefined): number;

/* ─────────────────────────────── Tab bar ────────────────────────────── */

export const TAB_BAR_HEIGHT: number;
export const TAB_BAR_SIDE_MARGIN: number;
export const TAB_BAR_MAX_WIDTH: number;
export const TAB_ROW_MARGIN: number;
export const TAB_PILL_HEIGHT: number;
export const TAB_CENTER_SIZE: number;
export const TAB_OPEN_DELAY: number;

export function arrangeTabs<T extends { key: string }>(
  tabs: readonly T[] | null | undefined,
  centerKey?: string | null
): { ordered: T[]; centerIndex: number };
export function tabCellWidth(rowWidth: number, count: number, rowMargin?: number): number;
export function pillOffset(orderedKeys: readonly string[], key: string, cellWidth: number, rowMargin?: number): number;
export function tabBarWidth(screenWidth: number, scale?: number, options?: { sideMargin?: number; maxWidth?: number }): number;
export function badgeText(count: number): string;
export function tabAccessibilityLabel(tab: { label: string; badge?: number }): string;

export const PAGINATION_HEIGHT: number;
/** Room to keep under a list so its last row scrolls above the pagination pill. */
export function paginationReserve(bottomInset: number | undefined): number;

/* ────────────────────────── Collapsible header ──────────────────────── */

export interface FadeRange {
  input: [number, number];
  output: [number, number];
}

export const HEADER_BAR_HEIGHT: number;
export const HEADER_FADE_RUN: number;
export const HEADER_BOTTOM_FADE: { readonly ios: number; readonly android: number };
export const HEADER_DEFAULT_THRESHOLD: number;
export function headerThreshold(titleBottom: number, topInset?: number): number;
export function headerBarFade(threshold: number): FadeRange;
export function headerTitleFade(threshold: number): { opacity: FadeRange; translateY: FadeRange };
export function headerBottomFade(platform: string): number;
export function headerGradientStops(barHeight: number, fadeLength: number): [number, number, number];
export function androidHeaderColors(pageBackground: string | undefined): [string, string, string];

/* ────────────────────────────── Markdown ────────────────────────────── */

export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export interface MarkdownListItem {
  depth: number;
  inlines: MarkdownInline[];
}

export type MarkdownBlock =
  | { kind: 'paragraph'; inlines: MarkdownInline[] }
  | { kind: 'heading'; level: number; inlines: MarkdownInline[] }
  | { kind: 'bullets'; items: MarkdownListItem[] }
  | { kind: 'numbers'; items: MarkdownListItem[]; start: number }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'quote'; inlines: MarkdownInline[] };

export function parseMarkdown(source: string | null | undefined): MarkdownBlock[];
export function parseInline(source: string | null | undefined): MarkdownInline[];
export function inlinesToText(inlines: readonly MarkdownInline[] | null | undefined): string;
export function splitTableRow(line: string): string[];

/* ──────────────────────────── Table columns ─────────────────────────── */

export interface MeasureColumnsOptions {
  charWidth?: number;
  headerCharWidth?: number;
  padding?: number;
  minWidth?: number;
  maxWidth?: number;
  targetWidth?: number;
  /** The phone's text size setting (1 = normal); below 1 is treated as 1. */
  fontScale?: number;
  /** Rounding onto the screen's pixel grid, e.g. PixelRatio.roundToNearestPixel. */
  round?: (value: number) => number;
}

export const TABLE_COLUMN_DEFAULTS: Readonly<Required<Omit<MeasureColumnsOptions, 'fontScale' | 'round'>>>;
export function isNumeric(value: unknown): boolean;
export function measureColumns(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  options?: MeasureColumnsOptions
): { widths: number[]; numeric: boolean[]; totalWidth: number };

/* ─────────────────────────── Question anchoring ─────────────────────── */

export const ANCHOR_MARGIN: number;
export function anchorOffset(anchorY: number): number;
export function reserveBelowQuestion(input: { viewportHeight: number; contentHeight: number; anchorY: number }): number;
