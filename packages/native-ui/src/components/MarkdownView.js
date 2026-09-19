/**
 * The rendering of an AI answer: a walk over the typed blocks that
 * `parseMarkdown` produces. The whole grammar is in the parser, tested dry;
 * here there is only style.
 *
 * Every default style can be overridden by name through `styles`.
 */
const { React, h, RN, LinearGradient } = require('./runtime');
const { GlassButton } = require('./GlassButton');
const { parseMarkdown, parseInline, inlinesToText } = require('../logic/markdown');
const { measureColumns } = require('../logic/tableColumns');
const { withAlpha } = require('../logic/color');

const hairline = RN.StyleSheet.hairlineWidth;

const DEFAULT_STYLES = {
  stack: { gap: 9 },
  body: { color: '#1d2440', fontSize: 15, lineHeight: 22 },
  plain: { color: '#ffffff', fontWeight: '500' },
  bold: { fontWeight: '700', color: '#0d1235' },
  italic: { fontStyle: 'italic' },
  link: { color: '#1f4dcc', textDecorationLine: 'underline' },
  inlineCode: { fontWeight: '500', fontSize: 13.5, color: '#315bd4', backgroundColor: 'rgba(59,108,240,0.10)' },
  heading: { color: '#0d1235', fontWeight: '800', fontSize: 17, lineHeight: 24, letterSpacing: -0.3 },
  headingSmall: { fontSize: 15, lineHeight: 21 },
  list: { gap: 5 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  listMarker: { minWidth: 15, color: '#1f4dcc', fontWeight: '700', fontSize: 14, lineHeight: 22 },
  listBody: { flex: 1 },
  code: {
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: 'rgba(13,18,53,0.04)',
    borderWidth: hairline,
    borderColor: 'rgba(13,18,53,0.08)'
  },
  codeBar: {
    height: 34,
    paddingLeft: 12,
    paddingRight: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8
  },
  codeLanguage: { color: 'rgba(13,18,53,0.45)', fontWeight: '700', fontSize: 10, letterSpacing: 0.6 },
  codeText: { paddingHorizontal: 12, paddingBottom: 11, color: '#26304c', fontWeight: '500', fontSize: 12.5, lineHeight: 19 },
  /* THE TABLE TOOK THE SCREEN'S HEIGHT. A one-row table stretched a thousand
     points tall on an iPhone. Not the table growing: the container of a
     horizontal ScrollView aligns its children with `stretch` on the vertical
     axis. `alignItems: flex-start` gives the table back its own height, and
     `alignSelf: flex-start` stops the scroller claiming more room than it
     fills. */
  tableFrame: { position: 'relative', alignSelf: 'flex-start', maxWidth: '100%' },
  tableVeil: { position: 'absolute', top: 0, bottom: 0, right: 0, width: 28 },
  tableScroll: { paddingVertical: 2, alignItems: 'flex-start' },
  tableScrollView: { flexGrow: 0, alignSelf: 'flex-start' },
  /* A CLEAN TABLE, NOT A GRID. A rounded frame, a rule between EVERY column
     and a painted header were four strokes and two colours for three
     numbers — the eye followed the grid instead of the data. What remains:
     one stroke under the header, a light rule between rows, nothing around.
     Columns separate by space. */
  table: { overflow: 'hidden' },
  /* `stretch`: the boxes of a row take the tallest one's height, or rows
     go out of line as soon as one cell wraps. */
  tableRow: { flexDirection: 'row', alignItems: 'stretch', borderTopWidth: hairline, borderTopColor: 'rgba(13,18,53,0.07)' },
  tableHeader: { borderTopWidth: 0, borderBottomWidth: hairline, borderBottomColor: 'rgba(13,18,53,0.22)' },
  /* The width lives on the BOX, not the text: a wide Text lets its content
     float in the room it gets, a wide box frames it. The 12 + 12 padding is
     the `padding` the column measure assumes. */
  tableCellBox: { paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'flex-start' },
  tableHeaderText: {
    color: 'rgba(13,18,53,0.52)',
    fontWeight: '600',
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.3,
    textTransform: 'uppercase'
  },
  tableCell: { color: '#0d1235', fontWeight: '500', fontSize: 13.5, lineHeight: 19 },
  /* A fully numeric column reads right-aligned, in tabular digits — or "1"
     and "8" differ in width and the column ripples from row to row. */
  tableCellNumber: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  quote: { paddingLeft: 11, paddingVertical: 2, borderLeftWidth: 2, borderLeftColor: 'rgba(59,108,240,0.35)' },
  quoteText: { color: 'rgba(13,18,53,0.7)', fontStyle: 'italic' }
};

function openLink(href) {
  Promise.resolve(RN.Linking.openURL(href)).catch(() => {});
}

const DEFAULT_VEIL = 'rgba(255,255,255,0.92)';
/* The default context lets `MarkdownTable` render on its own, outside a
   MarkdownView. */
const Ctx = React.createContext({ styles: DEFAULT_STYLES, onLinkPress: openLink, tableVeilColor: DEFAULT_VEIL });

function MarkdownView({
  content,
  plain = false,
  styles: overrides,
  onLinkPress = openLink,
  onCopyCode,
  copyLabel,
  copyIcon,
  copiedIcon,
  fontScale,
  tableVeilColor = DEFAULT_VEIL,
  testID
}) {
  const styles = React.useMemo(() => {
    const merged = { ...DEFAULT_STYLES };
    for (const key of Object.keys(overrides || {})) merged[key] = [DEFAULT_STYLES[key], overrides[key]];
    return merged;
  }, [overrides]);
  const blocks = React.useMemo(() => (plain ? [] : parseMarkdown(content)), [content, plain]);

  /* A person's own message is not Markdown: they typed what they wanted to
     see. Their stars and dashes are not taken away. */
  if (plain) return h(RN.Text, { testID, style: [styles.body, styles.plain] }, content);
  if (!blocks.length) return null;

  const context = { styles, onLinkPress, onCopyCode, copyLabel, copyIcon, copiedIcon, fontScale, tableVeilColor };
  return h(
    Ctx.Provider,
    { value: context },
    h(RN.View, { testID, style: styles.stack }, blocks.map((block, index) => h(Block, { key: index, block })))
  );
}

function Block({ block }) {
  const { styles } = React.useContext(Ctx);
  switch (block.kind) {
    case 'heading':
      return h(
        RN.Text,
        { accessibilityRole: 'header', style: [styles.heading, block.level >= 3 ? styles.headingSmall : null] },
        h(Inlines, { inlines: block.inlines })
      );
    case 'bullets':
    case 'numbers':
      return h(
        RN.View,
        { style: styles.list },
        block.items.map((item, index) =>
          h(
            RN.View,
            { key: index, style: [styles.listItem, { marginLeft: item.depth * 14 }] },
            h(RN.Text, { style: styles.listMarker }, block.kind === 'numbers' ? `${block.start + index}.` : '•'),
            h(RN.Text, { style: [styles.body, styles.listBody] }, h(Inlines, { inlines: item.inlines }))
          )
        )
      );
    case 'code':
      return h(CodeBlock, { language: block.language, text: block.text });
    case 'table':
      return h(MarkdownTable, { header: block.header, rows: block.rows });
    case 'quote':
      return h(
        RN.View,
        { style: styles.quote },
        h(RN.Text, { style: [styles.body, styles.quoteText] }, h(Inlines, { inlines: block.inlines }))
      );
    default:
      return h(RN.Text, { style: styles.body }, h(Inlines, { inlines: block.inlines }));
  }
}

function Inlines({ inlines }) {
  const { styles, onLinkPress } = React.useContext(Ctx);
  return h(
    React.Fragment,
    null,
    inlines.map((inline, index) => {
      if (inline.kind === 'bold') return h(RN.Text, { key: index, style: styles.bold }, inline.text);
      if (inline.kind === 'italic') return h(RN.Text, { key: index, style: styles.italic }, inline.text);
      if (inline.kind === 'code') return h(RN.Text, { key: index, style: styles.inlineCode }, inline.text);
      if (inline.kind === 'link') {
        return h(
          RN.Text,
          { key: index, accessibilityRole: 'link', style: styles.link, onPress: () => onLinkPress(inline.href) },
          inline.text
        );
      }
      return h(RN.Text, { key: index }, inline.text);
    })
  );
}

/* A plain-text cell stays a string: it inherits its cell's style directly,
   right alignment of numbers included. Only marked cells (bold, link…) go
   through the inline renderer. */
function cellContent(inlines) {
  if (!inlines || !inlines.length) return '';
  if (inlines.every((inline) => inline.kind === 'text')) return inlinesToText(inlines);
  return h(Inlines, { inlines });
}

/* A code block copies ALONE: in an answer that explains then shows, copying
   the whole bubble means trimming the clipboard by hand. The copy itself
   (clipboard, haptics) is the caller's. */
function CodeBlock({ language, text }) {
  const { styles, onCopyCode, copyLabel, copyIcon, copiedIcon } = React.useContext(Ctx);
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    await onCopyCode(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };
  return h(
    RN.View,
    { style: styles.code },
    h(
      RN.View,
      { style: styles.codeBar },
      h(RN.Text, { style: styles.codeLanguage }, language || 'code'),
      onCopyCode && copyIcon
        ? h(
            GlassButton,
            { accessibilityLabel: copyLabel, onPress: () => void copy().catch(() => {}), size: 26 },
            copied && copiedIcon ? copiedIcon : copyIcon
          )
        : null
    ),
    h(RN.ScrollView, { horizontal: true, showsHorizontalScrollIndicator: false }, h(RN.Text, { style: styles.codeText }, text))
  );
}

/**
 * A table, and not three lists side by side. Each column's width is computed
 * ONCE for the whole table (`measureColumns`), then imposed on the header and
 * on every row: the only way a value falls under its title.
 */
function MarkdownTable({ header, rows }) {
  const { styles, fontScale, tableVeilColor } = React.useContext(Ctx);
  const [contentWidth, setContentWidth] = React.useState(0);
  const [viewWidth, setViewWidth] = React.useState(0);
  const [moreOnRight, setMoreOnRight] = React.useState(true);
  /* Two points of slack: a one-pixel difference comes from density rounding,
     not from hidden content. */
  const overflows = contentWidth - viewWidth > 2;
  /* BOLD IN A CELL. Cells were shown raw: "**Starter**" came out with its
     stars. They go through the paragraph renderer, and columns are measured
     on the VISIBLE text, without the marks. */
  const head = React.useMemo(() => header.map(parseInline), [header]);
  const body = React.useMemo(() => rows.map((row) => row.map(parseInline)), [rows]);
  const { widths, numeric } = React.useMemo(
    () =>
      measureColumns(
        head.map(inlinesToText),
        body.map((row) => row.map(inlinesToText)),
        {
          /* THE REAL ROOM. The table fills the measured width; 300 only
             serves before the first measure. Wider than that, it scrolls. */
          targetWidth: viewWidth > 0 ? viewWidth : 300,
          fontScale: fontScale ?? RN.PixelRatio.getFontScale(),
          /* On the real pixel grid, or the hairlines render as two blurry greys. */
          round: (value) => RN.PixelRatio.roundToNearestPixel(value)
        }
      ),
    [head, body, viewWidth, fontScale]
  );

  const row = (cells, key, textStyle, extra) =>
    h(
      RN.View,
      { key, style: [styles.tableRow, extra] },
      widths.map((width, index) =>
        h(
          RN.View,
          { key: index, style: [styles.tableCellBox, { width }] },
          h(RN.Text, { style: [textStyle, numeric[index] ? styles.tableCellNumber : null] }, cellContent(cells[index]))
        )
      )
    );

  return h(
    RN.View,
    { style: styles.tableFrame },
    h(
      RN.ScrollView,
      {
        horizontal: true,
        /* The native indicator stays: on an overflowing table it is the only
           confirmation that the gesture does something. */
        showsHorizontalScrollIndicator: true,
        style: styles.tableScrollView,
        contentContainerStyle: styles.tableScroll,
        scrollEventThrottle: 16,
        onScroll: ({ nativeEvent }) => {
          const rest = nativeEvent.contentSize.width - nativeEvent.contentOffset.x - nativeEvent.layoutMeasurement.width;
          setMoreOnRight(rest > 2);
        },
        onContentSizeChange: (width) => setContentWidth(width),
        onLayout: ({ nativeEvent }) => setViewWidth(nativeEvent.layout.width)
      },
      h(
        RN.View,
        { style: styles.table },
        row(head, 'header', styles.tableHeaderText, styles.tableHeader),
        body.map((cells, index) => row(cells, index, styles.tableCell, null))
      )
    ),
    /* THE VEIL THAT SAYS THERE IS MORE. A column cut by the screen edge was
       read as an EMPTY column: nothing said the table scrolls. This gradient
       shows while something remains on the right and fades at the end. It
       takes no room and catches no finger. */
    overflows && moreOnRight
      ? h(LinearGradient, {
          pointerEvents: 'none',
          colors: [withAlpha(tableVeilColor, 0), tableVeilColor],
          start: { x: 0, y: 0.5 },
          end: { x: 1, y: 0.5 },
          style: styles.tableVeil
        })
      : null
  );
}

module.exports = { MarkdownView, MarkdownTable, MARKDOWN_STYLES: DEFAULT_STYLES };
