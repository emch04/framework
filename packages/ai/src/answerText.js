/**
 * The last look at an answer before a screen draws it, or a voice reads it.
 *
 * A mobile Markdown renderer draws a small subset — **bold**, "- " and "1. "
 * lists, "### " headings, "> " quotes — and shows everything else as raw
 * symbols. tidyMarkdown brings the answer back to that subset; plainText
 * strips it for a voice or a notification.
 *
 * verifyQuotations checks every quotation that cites a reference against the
 * text you hold. A model quotes from memory, or from another edition, despite
 * its instructions; an unfaithful quotation is replaced by the true text. What
 * a "reference" is and where its text lives is yours (verses, articles of law,
 * clauses of a contract): both are injected.
 */

/** Markdown and stray asterisks out, the words kept: what is read aloud. */
function plainText(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\s][^*]*)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/ ?\*+ ?/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.removeEmoji] drop emoji — for an app that draws its own symbols. Default false.
 */
function tidyMarkdown(text, options = {}) {
  let out = String(text === null || text === undefined ? '' : text)
    .replace(/```\w*\n?/g, '')
    /* A rule drawn across ("---", "***") is only a pause: a blank line. */
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
    /* Tables: the separator row goes, each row becomes "a · b · c". */
    .replace(/^[ \t]*\|[ \t:|-]+\|[ \t]*(\n|$)/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_row, cells) => cells.split('|').map((cell) => cell.trim()).filter(Boolean).join(' · '))
    .replace(/^#{1,6}\s+(.+)$/gm, '### $1')
    .replace(/^(\s*)[*•]\s+/gm, '$1- ')
    .replace(/__([^_\n]+)__/g, '**$1**')
    .replace(/(^|[^*])\*(?!\*)([^*\n]+?)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^*])\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  if (options.removeEmoji) {
    out = out.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, '');
  }
  return out
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* A quotation between guillemets, curly quotes or straight quotes. */
const QUOTATION = /(«\s*)([^«»]+?)(\s*»)|(“)([^“”]+)(”)|(")([^"\n]+)(")/g;
/* What may stand between a quotation and the reference saying where it comes from. */
const BETWEEN = /^\s*\(?\s*$/;
const ELLIPSIS = /…|\.\.\./;

/* Words only: no punctuation, no accents, no case. */
const foldWords = (text) => ` ${String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\d]+/gu, ' ').trim()} `;

/** Faithful when each piece of the quotation (cut by an ellipsis) is in the source. */
function isFaithfulQuotation(quoted, source) {
  const haystack = foldWords(source);
  return String(quoted).split(ELLIPSIS).map(foldWords).filter((piece) => piece.trim()).every((piece) => haystack.includes(piece));
}

/**
 * @param {string} text
 * @param {object} options
 * @param {Function} options.findReferences (text) => [{ start, end, refs }] — places cited, with offsets.
 * @param {Function} options.resolve async (refs) => the true text of those places, or null.
 * @returns {Promise<string>} the text, each unfaithful quotation followed by a
 *   reference replaced by the true text. When references cannot be read, unchanged.
 */
async function verifyQuotations(text, options = {}) {
  const source = String(text === null || text === undefined ? '' : text);
  if (typeof options.findReferences !== 'function' || typeof options.resolve !== 'function') {
    throw new Error('verifyQuotations requires options.findReferences and options.resolve.');
  }
  let references;
  try {
    references = (await options.findReferences(source)) || [];
  } catch (_error) {
    return source;
  }
  const replacements = [];
  for (const match of source.matchAll(QUOTATION)) {
    const groups = match.slice(1);
    const triple = [groups.slice(0, 3), groups.slice(3, 6), groups.slice(6, 9)].find((group) => group[1] !== undefined);
    const end = match.index + match[0].length;
    const reference = references.find((found) => found.start >= end && BETWEEN.test(source.slice(end, found.start)));
    if (!reference) continue;
    let truth = null;
    try {
      truth = await options.resolve(reference.refs);
    } catch (_error) {
      truth = null;
    }
    if (!truth || isFaithfulQuotation(triple[1], truth)) continue;
    replacements.push({ start: match.index, end, value: `${triple[0]}${truth}${triple[2]}` });
  }
  let out = source;
  for (const { start, end, value } of replacements.reverse()) out = out.slice(0, start) + value + out.slice(end);
  return out;
}

module.exports = { plainText, tidyMarkdown, verifyQuotations, isFaithfulQuotation };
