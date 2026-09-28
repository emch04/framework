const { contentHash, textBlocks } = require('./documents');

function sentencesOf(text) {
  return String(text).split(/(?<=[.!?…](?:\s?[»”’")\]])*)\s+(?=(?:[«“"(]\s?)?\p{Lu})/u).filter(Boolean);
}
function splitLong(text, room) {
  const pieces = [];
  let current = '';
  for (const sentence of sentencesOf(text)) {
    if (current && current.length + 1 + sentence.length > room) { pieces.push(current); current = ''; }
    if (sentence.length > room) {
      if (current) pieces.push(current);
      current = '';
      const words = sentence.split(/\s+/);
      let segment = '';
      for (const word of words) {
        if (segment && segment.length + 1 + word.length > room) { pieces.push(segment); segment = ''; }
        if (word.length > room) {
          if (segment) pieces.push(segment);
          segment = '';
          for (let at = 0; at < word.length; at += room) pieces.push(word.slice(at, at + room));
        } else segment = segment ? `${segment} ${word}` : word;
      }
      if (segment) pieces.push(segment);
    } else current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) pieces.push(current);
  return pieces;
}
function normalizeBlocks(input) {
  if (typeof input === 'string') return textBlocks(input);
  if (!Array.isArray(input)) throw new TypeError('INVALID_BLOCKS');
  return input.map((block, index) => typeof block === 'string' ? { kind: 'paragraph', text: block, number: index + 1 } : {
    kind: block.kind || 'paragraph', text: String(block.text ?? ''), number: block.number,
    group: block.group, together: block.together
  }).filter((block) => block.text.trim());
}
function unitsOf(blocks, maxLength, context) {
  const units = [];
  let heading = context;
  let activeQuestion = '';
  const seenTogether = new Set();
  for (const block of blocks) {
    if (block.kind === 'heading') { heading = block.text.trim(); activeQuestion = ''; seenTogether.clear(); continue; }
    if (block.kind === 'question') { activeQuestion = block.text.trim(); seenTogether.clear(); continue; }
    const paragraphs = Array.isArray(block.together) && block.together.length > 1 ? block.together : [block];
    const group = block.group ?? (paragraphs.length > 1 ? contentHash(paragraphs.map((part) => part.number ?? part.text)) : undefined);
    if (paragraphs.length > 1 && seenTogether.has(group)) continue;
    if (paragraphs.length > 1) seenTogether.add(group);
    const prefix = [heading, activeQuestion].filter(Boolean).join('\n');
    const numbers = [...new Set(paragraphs.map((part) => part.number).filter(Number.isInteger))];
    const body = paragraphs.map((part) => String(part.text).trim()).join('\n');
    const room = Math.max(1, maxLength - (prefix ? prefix.length + 1 : 0));
    const parts = body.length > room ? splitLong(body, room) : [body];
    for (const part of parts) units.push({ context: prefix || heading, text: part, group, numbers });
  }
  return units;
}
function chunkBlocks(input, { maxLength = 1500, minLength = 40, overlap = 0, context = '', sourceId = '' } = {}) {
  if (!Number.isInteger(maxLength) || maxLength < 1 || !Number.isInteger(minLength) || minLength < 0 || !Number.isInteger(overlap) || overlap < 0) throw new TypeError('INVALID_CHUNK_OPTIONS');
  const units = unitsOf(normalizeBlocks(input), maxLength, context);
  const groups = [];
  for (const unit of units) {
    const last = groups.at(-1);
    if (unit.group !== undefined && last?.group === unit.group && last.context === unit.context && last.text.length + 1 + unit.text.length <= maxLength - unit.context.length - 1) {
      last.text += `\n\n${unit.text}`;
      last.numbers.push(...unit.numbers);
    } else groups.push({ ...unit });
  }
  const chunks = [];
  let current = [];
  const render = (items) => [items[0]?.context, ...items.map((item) => item.text)].filter(Boolean).join('\n\n');
  const flush = () => {
    if (!current.length) return;
    const text = render(current);
    if (text.length >= minLength) {
      const hash = contentHash({ sourceId, text });
      chunks.push({ id: `${sourceId}:${hash}`, text, contentHash: hash, numbers: [...new Set(current.flatMap((item) => item.numbers))], context: current[0].context });
    }
  };
  for (const group of groups) {
    if (current.length && (current[0].context !== group.context || render([...current, group]).length > maxLength)) {
      flush();
      current = current[0].context === group.context && overlap ? current.slice(-overlap) : [];
      while (current.length && render([...current, group]).length > maxLength) current.shift();
    }
    current.push(group);
  }
  flush();
  return chunks;
}
function chunkText(input, options = {}) { return chunkBlocks(input, { minLength: 1, ...options }).map((chunk) => chunk.text); }
module.exports = { sentencesOf, chunkBlocks, chunkText };
