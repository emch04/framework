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
