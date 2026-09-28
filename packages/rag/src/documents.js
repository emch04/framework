const { createHash } = require('crypto');

const decodeEntities = (value) => String(value).replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
  const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
});
const clean = (text) => decodeEntities(text).replace(/[\u200b\u00ad]/g, '').replace(/\s+/g, ' ').trim();

function htmlBlocks(html) {
  const body = String(html ?? '').replace(/<(script|style|aside|nav|form|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const blocks = [];
  for (const [, tag, attributes, content] of body.matchAll(/<(h[1-6]|p|li|blockquote)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const text = clean(content.replace(/<br\b[^>]*\/?\s*>/gi, ' ').replace(/<[^>]*>/g, ''));
    if (!text) continue;
    const number = /data-(?:pnum|paragraph)=["'](\d+)["']/.exec(attributes)?.[1];
    const kind = /^h/.test(tag) ? 'heading' : /\bquestion\b|\bqu\b/.test(attributes) ? 'question' : 'paragraph';
    blocks.push({ kind, text, ...(number ? { number: Number(number) } : {}) });
  }
  return blocks;
}
function markdownBlocks(markdown) {
  return String(markdown ?? '').replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/).flatMap((part) => {
    const lines = part.trim().split('\n');
    if (!lines[0]) return [];
    const heading = /^#{1,6}\s+(.+)$/.exec(lines[0]);
    const text = clean(lines.map((line) => line.replace(/^\s*(?:[-*+] |\d+[.)] )/, '').replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '')).join(' '));
    return [{ kind: heading ? 'heading' : 'paragraph', text: heading ? clean(heading[1]) : text }];
  }).filter((block) => block.text);
}
function textBlocks(text) {
  return String(text ?? '').split(/\n\s*\n/).map((part) => ({ kind: 'paragraph', text: clean(part) })).filter((part) => part.text);
}
function normalizeDocument(input, { extractors = {}, format = input?.format || 'text' } = {}) {
  if (!input || typeof input !== 'object' || !input.id) throw new TypeError('INVALID_DOCUMENT');
  const extractor = extractors[format] || { html: htmlBlocks, markdown: markdownBlocks, text: textBlocks }[format];
  if (typeof extractor !== 'function') throw new TypeError('EXTRACTOR_REQUIRED');
  const blocks = extractor(input.content ?? input.text ?? '', input);
  if (!Array.isArray(blocks) || blocks.some((block) => !block || !['heading', 'question', 'paragraph'].includes(block.kind) || typeof block.text !== 'string')) throw new TypeError('INVALID_BLOCKS');
  const normalized = blocks.map((block) => ({ ...block, text: clean(block.text) })).filter((block) => block.text);
  return { id: String(input.id), version: input.version ?? null, title: clean(input.title ?? ''), format, metadata: input.metadata || {}, blocks: normalized };
}
function contentHash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
module.exports = { normalizeDocument, htmlBlocks, markdownBlocks, textBlocks, contentHash };
