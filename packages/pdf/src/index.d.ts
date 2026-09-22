/**
 * A PDFKit document — structurally typed so this package needs no dependency
 * on PDFKit's own types. Anything exposing this surface works.
 */
export interface PdfDocumentLike {
  text(text: string, x?: number, y?: number, options?: Record<string, unknown>): unknown;
  heightOfString(text: string, options?: Record<string, unknown>): number;
  rect(x: number, y: number, width: number, height: number): { fill(color: string): unknown; stroke(color?: string): unknown };
  fill(color: string): unknown;
  stroke(color?: string): unknown;
  fillColor(color: string): unknown;
  font(name: string): unknown;
  fontSize(size: number): unknown;
  addPage(options?: Record<string, unknown>): unknown;
  page: { width: number; height: number; margins: { top: number; bottom: number; left: number; right: number } };
  [key: string]: unknown;
}

/**
 * Shorten `text` until it fits `width` on one line, ellipsis included.
 * Measured with the ACTIVE font — call after font()/fontSize().
 */
export function fitText(doc: PdfDocumentLike, text: unknown, width: number): string;

/** Draw one line of text, bounded and truncated so it cannot overlap its neighbour. */
export function line(
  doc: PdfDocumentLike,
  text: unknown,
  x: number,
  y: number,
  width: number,
  options?: Record<string, unknown>
): unknown;

/** How tall wrapped text will be at this width — for rows that grow with their content. */
export function blockHeight(
  doc: PdfDocumentLike,
  text: unknown,
  width: number,
  options?: Record<string, unknown>
): number;

/** Where the usable area of a page ends: page height less `reserve` (default 40). */
export function defaultBottom(doc: PdfDocumentLike, reserve?: number): number;

/**
 * Make room for a block that must not be split across pages.
 * @returns the y to draw at — unchanged, or the top of a fresh page.
 */
export function keepTogether(doc: PdfDocumentLike, options: {
  y: number;
  height: number;
  bottom?: number;
  top?: number;
}): number;

export interface TableColumn<Row = Record<string, unknown>> {
  key: string;
  /** Header text. Defaults to `key`. */
  label?: string;
  /** Omit to share whatever width the declared columns leave. */
  width?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Let this cell wrap and grow the row. Everything else is truncated. */
  wrap?: boolean;
  fontSize?: number;
  format?: (value: unknown, row: Row) => unknown;
}

export interface TableResult {
  /** Where the cursor ended up, for whatever is drawn next. */
  y: number;
  pages: number;
  rows: number;
}

export function drawTable<Row = Record<string, unknown>>(doc: PdfDocumentLike, options: {
  columns: Array<TableColumn<Row>>;
  rows?: Row[];
  x: number;
  y: number;
  width: number;
  /** y past which a new page begins. Raise it to reserve room for a totals block. */
  bottom?: number;
  /** y to resume at on a new page. Defaults to the top margin. */
  top?: number;
  onNewPage?: (doc: PdfDocumentLike) => void;
  minRowHeight?: number;
  padding?: number;
  cellPadding?: number;
  headerFill?: string;
  headerStroke?: string;
  rowStroke?: string;
  /** Fill colour for every other row. Unset means no striping. */
  zebra?: string | null;
  fontSize?: number;
  headerFontSize?: number;
  font?: string;
  headerFont?: string;
  color?: string;
}): TableResult;

/** Credit-card size (ISO/IEC 7810 ID-1, 85.6 × 54 mm), in PDF points. */
export const CARD_SIZE: Readonly<{ width: number; height: number }>;
export const PAPERS: Readonly<Record<'A4' | 'LETTER', Readonly<{ width: number; height: number }>>>;

export type CardDrawer = (doc: PdfDocumentLike, x: number, y: number, width: number, height: number, index: number) => void;

/**
 * A home-printing sheet: a page of fronts, then a page of backs mirrored
 * horizontally so long-edge duplex printing lands card on card.
 */
export function imposeCards(doc: PdfDocumentLike, options: {
  front: CardDrawer;
  back?: CardDrawer;
  paper?: 'A4' | 'LETTER';
  columns?: number;
  rows?: number;
  card?: { width: number; height: number };
  columnGap?: number;
  rowGap?: number;
  cropMarks?: boolean;
}): { perPage: number; positions: Array<{ x: number; y: number }> };

export function drawCropMarks(doc: PdfDocumentLike, x: number, y: number, width: number, height: number,
  options?: { length?: number; gap?: number; color?: string }): void;

/** A QR code as vector squares, from a module matrix (e.g. `require('qrcode').create(text).modules`). */
export function drawQrMatrix(doc: PdfDocumentLike, modules: { size: number; get(row: number, column: number): boolean | number },
  x: number, y: number, size: number,
  options?: { color?: string; background?: string | null; quietZone?: number; radius?: number }): void;

export type SocialNetwork = 'instagram' | 'tiktok' | 'snapchat';
export const SOCIAL_NETWORKS: readonly SocialNetwork[];
/** The official logo, in brand colors, as a rounded app-style square. */
export function drawSocialLogo(doc: PdfDocumentLike, network: SocialNetwork, x: number, y: number, size: number): void;
