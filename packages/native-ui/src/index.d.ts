/**
 * @astratra/native-ui — the mobile interface kit.
 *
 * The React Native types are NOT imported: react-native is a peer, and this
 * repository does not install it. Styles and animated values are typed
 * loosely here (`NativeStyle`, `SharedNumber`) — the app's own types flow
 * through untouched.
 */
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { ColorScheme, GlassMode, PictureSize } from './logic';

export * from './logic';

/** A React Native style, style array or registered style. */
export type NativeStyle = unknown;
/** A Reanimated shared value holding a number (0..1 for `collapse`). */
export interface SharedNumber {
  value: number;
}
/** The scroll event React Native hands to `onScroll`. */
export interface ScrollEventLike {
  nativeEvent: { contentOffset: { y: number } };
}

/** The glass this device renders, decided once for the app. */
export function getGlassMode(): GlassMode;

/* ──────────────────────────────── Glass ─────────────────────────────── */

export interface GlassSurfaceProps {
  children?: ReactNode;
  style?: NativeStyle;
  /** Declared as for Apple's glass; off iOS it is painted at Apple's real weight. */
  tintColor?: string;
  glassStyle?: 'regular' | 'clear';
  /** A button (keeps its shadow, gets the frost) rather than a container. */
  interactive?: boolean;
  scheme?: ColorScheme;
  testID?: string;
}
export function GlassSurface(props: GlassSurfaceProps): ReactElement;

export interface GlassGroupProps {
  children?: ReactNode;
  spacing?: number;
  style?: NativeStyle;
  [prop: string]: unknown;
}
export function GlassGroup(props: GlassGroupProps): ReactElement;

export interface GlassButtonProps {
  children?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  /** Diameter of a circle, height of a pill. */
  size?: number;
  pill?: boolean;
  /** Solid colour of the main action: tinted glass, light content. */
  tint?: string;
  disabled?: boolean;
  selected?: boolean;
  scheme?: ColorScheme;
  style?: NativeStyle;
  testID?: string;
}
export function GlassButton(props: GlassButtonProps): ReactElement;

/* ─────────────────────────────── Cards ──────────────────────────────── */

export interface PaleCardProps {
  children?: ReactNode;
  /** Accent colour for the current scheme; absent = the neutral card. */
  tint?: string | null;
  /** Defaults to white / black. */
  pageBackground?: string;
  /** The theme's text colour, used by the neutral card. */
  ink?: string;
  scheme?: ColorScheme;
  style?: NativeStyle;
  [prop: string]: unknown;
}
export function PaleCard(props: PaleCardProps): ReactElement;
export function TappableCard(props: Omit<PaleCardProps, 'tint'> & { tint?: string }): ReactElement;
export function usePaleCardColors(input?: {
  tint?: string | null;
  pageBackground?: string;
  ink?: string;
  scheme?: ColorScheme;
}): { fill: string; top: string; bottom: string };

export function Chevron(props: {
  direction?: 'left' | 'right' | 'up' | 'down';
  color?: string;
  size?: number;
  strokeWidth?: number;
}): ReactElement;

/* ──────────────────────────── Floating bars ─────────────────────────── */

export function useCollapsingBar(): { collapse: SharedNumber; onScroll: (event: ScrollEventLike) => void };
/** The shared fold style (translate + scale toward the bottom). */
export function useCollapseTransform(collapse?: SharedNumber): NativeStyle;

export interface FloatingPaginationProps {
  page: number;
  totalPages: number;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  previousLabel: string;
  nextLabel: string;
  collapse?: SharedNumber;
  /** Distance from the bottom when a footer button already sits there. */
  bottom?: number;
  bottomInset?: number;
  onHaptic?: () => void;
  previousIcon?: ReactNode;
  nextIcon?: ReactNode;
  scheme?: ColorScheme;
  testID?: string;
}
export function FloatingPagination(props: FloatingPaginationProps): ReactElement;

export interface TabIconState {
  color: string;
  size: number;
  strokeWidth: number;
  active: boolean;
}

export interface TabBarTab {
  key: string;
  label: string;
  badge?: number;
  icon?: (state: TabIconState) => ReactNode;
}

export interface TabBarColors {
  active: string;
  idle: string;
  pill: string;
  badge: string;
  badgeRing: string;
}

export interface TabBarProps<T extends TabBarTab = TabBarTab> {
  tabs: readonly T[];
  activeKey: string;
  onSelect: (tab: T) => void;
  /** Raised in the middle, never takes the pill. */
  centerKey?: string;
  renderCenter?: (input: { tab: T; size: number }) => ReactNode;
  collapse?: SharedNumber;
  bottomInset?: number;
  onHaptic?: () => void;
  /** Delay before `onSelect`, so the pill's slide is seen. */
  openDelay?: number;
  /** e.g. expo-router's useFocusEffect, when the bar is rendered inside each screen. */
  useFocusEffect?: (effect: () => void | (() => void)) => void;
  colors?: Partial<TabBarColors>;
  scheme?: ColorScheme;
  testID?: string;
}
export function TabBar<T extends TabBarTab>(props: TabBarProps<T>): ReactElement;

/* ────────────────────────── Collapsible header ──────────────────────── */

export interface CollapsibleHeaderApi {
  scrollY: SharedNumber;
  threshold: SharedNumber;
  onScroll: (event: ScrollEventLike) => void;
  onTitleLayout: (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
  onListTitleLayout: (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
  measureTitle: (node: unknown) => void;
  originRef: { current: unknown };
}
export function useCollapsibleHeader(options?: { topInset?: number }): CollapsibleHeaderApi;

export interface CollapsibleHeaderProps {
  title: string;
  scrollY: SharedNumber;
  threshold: SharedNumber;
  /** Fixed on the left: usually a back GlassButton. */
  leading?: ReactNode;
  /** Fixed on the right. */
  actions?: ReactNode;
  topInset?: number;
  gutter?: number;
  pageBackground?: string;
  titleColor?: string;
  /** e.g. @react-native-masked-view/masked-view, for the iOS blur's fade. */
  MaskedView?: ComponentType<{ style?: NativeStyle; maskElement: ReactElement; children?: ReactNode }>;
  scheme?: ColorScheme;
  testID?: string;
}
export function CollapsibleHeader(props: CollapsibleHeaderProps): ReactElement;

export interface CollapsibleScreenProps extends Omit<CollapsibleHeaderProps, 'scrollY' | 'threshold'> {
  largeTitle?: ReactNode;
  children?: ReactNode;
  contentContainerStyle?: NativeStyle;
  scrollProps?: { onScroll?: (event: ScrollEventLike) => void; [prop: string]: unknown };
}
export function CollapsibleScreen(props: CollapsibleScreenProps): ReactElement;

/* ───────────────────────────── AI answers ───────────────────────────── */

export interface MarkdownViewProps {
  content: string;
  /** The person's own message: shown as typed. */
  plain?: boolean;
  /** Style overrides by name (body, heading, tableCell, …), merged with the defaults. */
  styles?: Record<string, NativeStyle>;
  onLinkPress?: (href: string) => void;
  /** Copies one code block; the button shows only with a copyIcon. */
  onCopyCode?: (text: string) => void | Promise<void>;
  copyLabel?: string;
  copyIcon?: ReactNode;
  copiedIcon?: ReactNode;
  /** Defaults to PixelRatio.getFontScale(). */
  fontScale?: number;
  tableVeilColor?: string;
  testID?: string;
}
export function MarkdownView(props: MarkdownViewProps): ReactElement | null;
export function MarkdownTable(props: { header: string[]; rows: string[][] }): ReactElement;
export const MARKDOWN_STYLES: Readonly<Record<string, NativeStyle>>;

/* ────────────────────────────── Pictures ────────────────────────────── */

/** What an image component takes (React Native's Image or expo-image). */
export interface ImageSourceLike {
  uri: string;
  headers?: Record<string, string>;
  [prop: string]: unknown;
}

export interface ImageShimmerProps {
  /** Width / height of the place held (1: a square). */
  ratio?: number;
  borderRadius?: number;
  colors?: { base?: string; light?: string; caption?: string };
  /** Read by the screen reader: the app's words ("Drawing the picture"). */
  accessibilityLabel?: string;
  caption?: string;
  captionStyle?: NativeStyle;
  passMs?: number;
  scheme?: ColorScheme;
  style?: NativeStyle;
  testID?: string;
}
export function ImageShimmer(props: ImageShimmerProps): ReactElement;

export interface AutoRatioImageProps {
  /** A ready source. */
  source?: ImageSourceLike | null;
  /** Or a source to fetch; resolving null or rejecting shows the error slot. */
  load?: () => ImageSourceLike | null | undefined | Promise<ImageSourceLike | null | undefined>;
  /** Names the picture (required with `load`): a new key starts over. Defaults to `source.uri`. */
  sourceKey?: string | number;
  /** React Native's Image by default; expo-image's Image fits. */
  ImageComponent?: ComponentType<any>;
  imageProps?: Record<string, unknown>;
  fit?: 'contain' | 'cover';
  /** The shape held until the picture is known (1). */
  initialRatio?: number;
  minRatio?: number;
  maxRatio?: number;
  borderRadius?: number;
  surfaceColor?: string;
  /** Replaces the default shimmer while loading; null for none. */
  placeholder?: ReactNode;
  loadingLabel?: string;
  renderError?: (input: { retry: () => void }) => ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  onLoad?: (size: PictureSize | null) => void;
  onError?: (error: unknown) => void;
  onRatio?: (ratio: number) => void;
  revealMs?: number;
  scheme?: ColorScheme;
  style?: NativeStyle;
  testID?: string;
}
export function AutoRatioImage(props: AutoRatioImageProps): ReactElement;

export interface ViewerPicture {
  /** Stable across renders. */
  key: string;
  title?: string;
  /** Read by the screen reader; defaults to the title. */
  accessibilityLabel?: string;
  /** Used when no `resolveSource` is given. */
  source?: ImageSourceLike;
  [prop: string]: unknown;
}

export interface ViewerAction<P extends ViewerPicture = ViewerPicture> {
  key: string;
  label: string;
  icon: ReactNode;
  /** May resolve a short notice to show ("Saved"); a rejection goes to onActionError. */
  onPress: (picture: P) => void | string | Promise<void | string | null | undefined>;
}

export interface ImageViewerProps<P extends ViewerPicture = ViewerPicture> {
  pictures: readonly P[];
  /** The picture to open on; null: closed. */
  start: number | null;
  onClose: () => void;
  onIndexChange?: (index: number) => void;
  resolveSource?: (picture: P) => ImageSourceLike | null | undefined | Promise<ImageSourceLike | null | undefined>;
  ImageComponent?: ComponentType<any>;
  imageProps?: Record<string, unknown>;
  labels: {
    close: string;
    share?: string;
    details?: string;
    /** "3 of 12": position from 1. */
    counter?: (position: number, count: number) => string;
    zoomHint?: string;
  };
  icons: {
    close: ReactNode;
    share?: ReactNode;
    details?: ReactNode;
    detailsActive?: ReactNode;
    failed?: ReactNode;
    notice?: ReactNode;
  };
  /** The share hook; shown with icons.share. */
  onShare?: (picture: P) => void | string | Promise<void | string | null | undefined>;
  actions?: readonly ViewerAction<P>[];
  onActionError?: (error: unknown, key: string, picture: P) => void;
  renderDetails?: (picture: P) => ReactNode;
  /** The safe area (react-native-safe-area-context's insets). */
  insets?: { top?: number; bottom?: number };
  onHaptic?: (kind: 'selection' | 'impact' | 'success' | 'failure') => void;
  testID?: string;
}
export function ImageViewer<P extends ViewerPicture>(props: ImageViewerProps<P>): ReactElement;
