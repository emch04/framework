/**
 * A Markdown parser for AI answers.
 *
 * A model writes Markdown; the screen used to render only its tables, and
 * everything else came out raw — "**important**" displayed with its stars.
 * No library is added for all that: Markdown renderers promise nothing on
 * React 19 / recent React Native, and above all they do not test dry. Here
 * parsing is a pure function, checked without mounting React, and rendering
 * (`MarkdownView`) is only a walk over the structure it returns.
 *
 * Block kinds: paragraph, heading, bullets, numbers, code, table, quote.
 * Inline kinds: text, bold, italic, code, link.
 */

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+][ \t]+(.*)$/;
const NUMBER = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)\s*$/;
/* A table's marker: the row of dashes under the header. */
const TABLE_RULE = /^\s*\|?\s*:?-{3,}/;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Two spaces of indentation = one level; a tab counts the same. */
const depthOf = (indent) => Math.floor(indent.replace(/\t/g, '  ').length / 2);

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseMarkdown(source) {
  const lines = String(source ?? '').split(/\r?\n/);
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (text) blocks.push({ kind: 'paragraph', inlines: parseInline(text) });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = FENCE.exec(line);

    if (fence) {
      flushParagraph();
      /* A code block is opaque: no indentation trimmed, no star interpreted.
         A missing closing fence must not silently swallow what follows
         either — take everything to the end and stop there. */
      const closing = fence[1][0];
      const body = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const candidate = FENCE.exec(lines[cursor]);
        if (candidate && candidate[1][0] === closing && !candidate[2]) break;
        body.push(lines[cursor]);
        cursor += 1;
      }
      blocks.push({ kind: 'code', language: fence[2] || null, text: body.join('\n') });
      index = cursor;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    /* NO RULE BETWEEN PARAGRAPHS. A `---`, `***` or `___` line (Markdown's
       horizontal rule) was displayed as is, three dashes in the middle of the
       text. It separates nothing more than the space between two paragraphs
       already does: it is dropped. */
    if (HORIZONTAL_RULE.test(line)) {
      flushParagraph();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: heading[1].length, inlines: parseInline(heading[2].trim()) });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      const body = [quote[1]];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const next = QUOTE.exec(lines[cursor]);
        if (!next) break;
        body.push(next[1]);
        cursor += 1;
      }
      blocks.push({ kind: 'quote', inlines: parseInline(body.join('\n').trim()) });
      index = cursor - 1;
      continue;
    }

    /* A table only announces itself on its SECOND line: the current line is
       a header only if the next one is made of dashes. */
    if (line.includes('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1])) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].includes('|')) {
        rows.push(splitTableRow(lines[cursor]));
        cursor += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      index = cursor - 1;
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBER.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const kind = bullet ? 'bullets' : 'numbers';
      const items = [];
      let cursor = index;
      while (cursor < lines.length) {
        const current = kind === 'bullets' ? BULLET.exec(lines[cursor]) : NUMBER.exec(lines[cursor]);
        if (!current) break;
        const text = kind === 'bullets' ? current[2] : current[3];
        items.push({ depth: depthOf(current[1]), inlines: parseInline(text.trim()) });
        cursor += 1;
      }
      if (numbered) {
        /* ONE STEP PER BLOCK, ALL "1.". Bullets under each step cut a numbered
           list into several blocks, and each restarted at 1 (seen on an
           Android capture: "1. 1. 1."). The written number is authoritative;
           a "1." that follows a numbered list, separated from it only by
           bullets, CONTINUES it. A paragraph in between still starts a new
           list. */
        const written = Number(numbered[2]);
        const previous = [...blocks].reverse().find((block) => block.kind !== 'bullets');
        const next = previous && previous.kind === 'numbers' ? previous.start + previous.items.length : 1;
        blocks.push({ kind: 'numbers', items, start: written === 1 ? next : written });
      } else {
        blocks.push({ kind: 'bullets', items });
      }
      index = cursor - 1;
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

/**
 * Cuts a paragraph into fragments. A delimiter that never closes stays text:
 * without that rule, one stray star in the middle of an answer put the whole
 * rest of the message in bold.
 */
function parseInline(source) {
  const text = String(source ?? '');
  const inlines = [];
  let plain = '';

  const flush = () => {
    if (plain) inlines.push({ kind: 'text', text: plain });
    plain = '';
  };

  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);

    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      flush();
      inlines.push({ kind: 'code', text: code[1] });
      index += code[0].length;
      continue;
    }

    const bold = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (bold) {
      flush();
      inlines.push({ kind: 'bold', text: bold[2] });
      index += bold[0].length;
      continue;
    }

    /* Italic is recognised by the star only: a lone underscore appears in
       identifiers (`final_grade`) far more often than as a style intent, and
       taking it for a delimiter ate the word. */
    const italic = /^\*(?=[^\s*])([^*\n]*[^\s*])\*/.exec(rest);
    if (italic) {
      flush();
      inlines.push({ kind: 'italic', text: italic[1] });
      index += italic[0].length;
      continue;
    }

    const link = /^\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      inlines.push({ kind: 'link', text: link[1] || link[2], href: link[2] });
      index += link[0].length;
      continue;
    }

    plain += text[index];
    index += 1;
  }

  flush();
  return inlines;
}

/** The plain text of a paragraph, delimiters removed — to copy, and to measure. */
function inlinesToText(inlines) {
  return (inlines || []).map((inline) => inline.text).join('');
}

module.exports = { parseMarkdown, parseInline, inlinesToText, splitTableRow };
