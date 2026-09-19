/**
 * Cleaning a model's reply before a human reads it.
 *
 * A rule written in the system prompt is a wish: the model follows it when it
 * suits it. Three leaks kept reaching real screens despite explicit
 * instructions, so this cleaner removes them deterministically:
 *
 *  1. Raw JSON. The model answers `{"title": "...", "features": [...]}` or wraps
 *     its real answer as `{"role": "...", "response": "..."}`. An earlier
 *     converter turned JSON into "title: ...", "features: ..." — the KEYS were
 *     still on screen. A JSON key is not a word for the user, even translated,
 *     so none is ever shown: a title becomes a bold line, text a paragraph, a
 *     list bullets, a named item "**Name** — description".
 *  2. Labels copied from a structure the model invented for itself
 *     ("**introduction** : ..."). Removed at the start of a line only — the same
 *     word inside a sentence is never touched.
 *  3. Reasoning drafts and robotic closings ("Wait, ...", "Final answer:",
 *     "Let me know if you need anything else.").
 *
 * The structural part (think blocks, JSON detection, prose conversion,
 * whitespace) is language-neutral and built in. Every WORD — which keys carry
 * the answer, which labels to drop, which closings are robotic — belongs to a
 * language and is supplied by the caller, per language.
 */

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** A vocabulary entry is a literal word (escaped) or a RegExp (its source is used as-is). */
function toSource(entry) {
  if (entry instanceof RegExp) return entry.source;
  return String(entry).replace(ESCAPE, '\\$&');
}

function alternation(entries) {
  return entries.map(toSource).join('|');
}

const VOCABULARY_FIELDS = [
  'payloadKeys', 'titleKeys', 'lineLabels', 'inlineLabels', 'headingLabels',
  'reasoningLabels', 'reasoningStarters', 'finalMarkers', 'planningStarters',
  'leadingFillers', 'annotationMarkers', 'closingPhrases', 'openers'
];

function mergeVocabularies(parts) {
  const merged = {};
  for (const field of VOCABULARY_FIELDS) {
    const seen = new Set();
    merged[field] = [];
    for (const part of parts) {
      for (const entry of (part && part[field]) || []) {
        const key = entry instanceof RegExp ? `re:${entry.source}` : `s:${entry}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged[field].push(entry);
      }
    }
  }
  return merged;
}

/* Lenient parse: models emit trailing commas, single quotes and unquoted keys.
   A strict JSON.parse alone let those through to the screen untouched. */
function lenientParse(str) {
  try { return JSON.parse(str); } catch (_e) { /* try the repaired form */ }
  try {
    const fixed = str
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/'/g, '"')
      // Unquoted keys, only right after { or , so text values are not rewritten.
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')
      .replace(/""+/g, '"');
    return JSON.parse(fixed);
  } catch (_e) {
    return null;
  }
}

function inlineValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value).trim();
  if (Array.isArray(value)) return value.map(inlineValue).filter(Boolean).join(', ');
  return Object.values(value).map(inlineValue).filter(Boolean).join(' — ');
}

function makeJsonToProse(titleKeys) {
  const titles = titleKeys.map((k) => String(k).toLowerCase());

  function jsonToProse(value, depth = 0) {
    const indent = '  '.repeat(depth);
    if (value === null || value === undefined) return '';
    if (typeof value !== 'object') return String(value).trim();

    if (Array.isArray(value)) {
      return value.map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const nameKey = Object.keys(item).find((k) => titles.includes(k.toLowerCase())
            && typeof item[k] === 'string' && item[k].trim());
          const rest = Object.entries(item)
            .filter(([k]) => k !== nameKey)
            .map(([, v]) => inlineValue(v))
            .filter(Boolean)
            .join(' — ');
          const head = nameKey ? `**${item[nameKey].trim()}**` : '';
          return `${indent}- ${head && rest ? `${head} — ${rest}` : head || rest}`;
        }
        return `${indent}- ${inlineValue(item)}`;
      }).filter((line) => line.trim() !== '-').join('\n');
    }

    // An object: its values in order, WITHOUT their keys. A title opens in bold.
    const blocks = [];
    for (const [key, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === '') continue;
      if (typeof v !== 'object') {
        const text = String(v).trim();
        if (!text) continue;
        blocks.push(titles.includes(key.toLowerCase()) ? `**${text}**` : text);
      } else {
        const prose = jsonToProse(v, Array.isArray(v) ? depth : depth + 1);
        if (prose) blocks.push(prose);
      }
    }
    return blocks.join('\n\n');
  }

  return jsonToProse;
}

function makeJsonConverter(vocabulary) {
  const jsonToProse = makeJsonToProse(vocabulary.titleKeys);

  /* When the model wraps its answer ({"role": "...", "response": "..."}), the
     payload field IS the answer; listing role/name alongside it is noise. */
  function payloadOf(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const key = vocabulary.payloadKeys.find((k) => typeof parsed[k] === 'string' && parsed[k].trim());
    return key ? parsed[key] : null;
  }

  function render(parsed) {
    return payloadOf(parsed) || jsonToProse(parsed, 0);
  }

  function convertRawJson(text) {
    let trimmed = text.trim();
    const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
    if (fence) trimmed = fence[1].trim();

    // The whole reply is JSON — only when it has at least one quoted key, so a
    // reply that merely starts with "[" is left alone.
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && /"[\wÀ-ÿ_]+"\s*:/.test(trimmed)) {
      const parsed = lenientParse(trimmed);
      if (parsed) return render(parsed) || text;
    }

    // A short preamble, then a JSON block.
    const jsonStart = trimmed.search(/\n\s*[{[]/);
    if (jsonStart > 0 && jsonStart < 200) {
      const preamble = trimmed.slice(0, jsonStart).trim();
      const parsed = lenientParse(trimmed.slice(jsonStart).trim());
      if (parsed) {
        const body = render(parsed);
        if (body) return (preamble ? `${preamble}\n\n` : '') + body;
      }
    }

    // Unparseable but clearly structured (3+ quoted keys): keep the values only.
    // Keys are erased here too — this path used to be the last place they leaked.
    const quotedKeys = (trimmed.match(/"[\wÀ-ÿ_]+"\s*:/g) || []).length;
    if (quotedKeys >= 3 && /^\s*\{/.test(trimmed)) {
      return trimmed
        .replace(/^\s*\{/, '').replace(/\}\s*$/, '')
        .replace(/"([\wÀ-ÿ_ ]+)"\s*:\s*/g, '')
        .replace(/[[\]{}]/g, '')
        .replace(/",?\s*/g, '\n')
        .replace(/"/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    return text;
  }

  /* JSON fragments pasted in the middle of prose (a tool result copied back). */
  function convertInlineJson(text) {
    return text.replace(
      /\{(?:\s*"[\wÀ-ÿ_]+"\s*:\s*(?:"[^"]*"|[\d.]+|true|false|null|\[.*?\]|\{[^}]*\})\s*,?\s*){2,}\}/g,
      (match) => {
        const parsed = lenientParse(match);
        if (!parsed) return match;
        return render(parsed) || match;
      }
    );
  }

  return { convertRawJson, convertInlineJson, jsonToProse };
}

function compile(vocabulary) {
  const v = vocabulary;
  const any = (list) => list.length > 0;
  const rx = {};

  if (any(v.payloadKeys)) {
    rx.payloadLabel = new RegExp(`^\\s*(?:\\*\\*)?(?:${alternation(v.payloadKeys)})(?:\\*\\*)?\\s*[:\\-—]\\s*`, 'i');
  }
  if (any(v.inlineLabels)) {
    rx.inlineLabels = new RegExp(`(?:^|\\s)(?:\\*\\*)?(?:${alternation(v.inlineLabels)})(?:\\*\\*)?\\s*[:\\-—]\\s*`, 'gi');
  }
  if (any(v.lineLabels)) {
    // Replaced by a paragraph break: the content stays, split as it was.
    rx.lineLabels = new RegExp(`(^|\\n)[ \\t]*(?:\\*\\*)?(?:${alternation(v.lineLabels)})(?:\\*\\*)?[ \\t]*:[ \\t]*`, 'gi');
  }

  /* Drafts chain corrections with no fixed marker ("Wait, ...", "Actually, ...",
     "Final answer:"). Patching word by word never ends, so the LAST line that
     looks like reasoning is found and only what follows it is kept: the model
     writes its last meta comment right before the real answer. */
  const boundary = [];
  if (any(v.finalMarkers)) {
    // The answer often follows on the same line after the colon: consume up to ':' only.
    boundary.push(`^[ \\t]*(?:${alternation(v.finalMarkers)})\\s*(?:\\([^)]*\\))?\\s*[:\\-—]`);
  }
  const labelBlock = any(v.reasoningLabels)
    ? `^[ \\t]*\\(?(?:${alternation(v.reasoningLabels)})(?:[\\s-]+\\w+){0,6}(?:\\s*\\([^)]*\\))?\\)?\\s*[:\\-—]`
    : null;
  if (labelBlock) boundary.push(`${labelBlock}.*$`);
  if (any(v.reasoningStarters)) boundary.push(`^[ \\t]*(?:${alternation(v.reasoningStarters)})\\b.*$`);
  if (boundary.length) rx.boundary = new RegExp(boundary.join('|'), 'gim');
  // Safety net: a labelled block still left (label + paragraph up to a blank line).
  if (labelBlock) rx.labelledBlock = new RegExp(`${labelBlock}.*(?:\\n(?!\\s*\\n).*)*`, 'gim');

  if (any(v.planningStarters)) {
    rx.planning = new RegExp(`^[\\s]*[*\\-•]\\s*(?:${alternation(v.planningStarters)}).*$`, 'gim');
  }
  if (any(v.leadingFillers)) {
    // Punctuation is required after the filler: "Bon" must not eat "Bonjour".
    rx.filler = new RegExp(`^(?:${alternation(v.leadingFillers)})\\s*[.,!]+\\s*`, 'i');
  }
  if (any(v.annotationMarkers)) {
    rx.annotation = new RegExp(`^.*\\((?:${alternation(v.annotationMarkers)}).*\\).*$`, 'gim');
  }
  if (any(v.headingLabels)) {
    /* Bold may wrap the label, and the colon is absent when the label holds its
       own line: an expression requiring "^label:" saw neither case. */
    const h = alternation(v.headingLabels);
    rx.headingAlone = new RegExp(`^\\s*(?:\\*\\*)?\\s*(?:${h})\\s*(?:\\*\\*)?\\s*:?\\s*(?:\\*\\*)?\\s*$`, 'gim');
    rx.headingLead = new RegExp(`^\\s*(?:\\*\\*)?\\s*(?:${h})\\s*(?:\\*\\*)?\\s*:\\s*`, 'gim');
  }
  if (any(v.closingPhrases)) {
    rx.closing = new RegExp(`\\s*(?:${alternation(v.closingPhrases)})\\s*$`, 'i');
  }
  if (any(v.openers)) {
    rx.openers = new RegExp(`(?:^|\\n)\\s*(?:${alternation(v.openers)})\\s*[.!?]?\\s*`, 'gi');
  }
  return rx;
}

/**
 * @param {object} [options]
 * @param {object} [options.shared]     vocabulary applied whatever the language
 *   (JSON keys are usually English whatever language the user speaks).
 * @param {Record<string, object>} [options.languages] vocabulary per language.
 * @param {string} [options.fallbackLanguage] used when clean() gets an unknown language.
 * @param {number} [options.maxClosingPasses=3] successive robotic closings removed.
 */
function createResponseCleaner(options = {}) {
  const shared = options.shared || {};
  const languages = options.languages || {};
  const fallbackLanguage = options.fallbackLanguage || null;
  const maxClosingPasses = options.maxClosingPasses ?? 3;
  const cache = new Map();

  function forLanguage(language) {
    const lang = language && languages[language] ? language : fallbackLanguage;
    const key = lang || '';
    if (!cache.has(key)) {
      const vocabulary = mergeVocabularies([shared, lang ? languages[lang] : null]);
      cache.set(key, { vocabulary, rx: compile(vocabulary), json: makeJsonConverter(vocabulary) });
    }
    return cache.get(key);
  }

  function clean(text, cleanOptions = {}) {
    if (text === null || text === undefined) return '';
    const { rx, json } = forLanguage(cleanOptions.language);
    let out = String(text);

    // Reasoning blocks, closed or cut off mid-stream.
    out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
    out = out.replace(/<think>[\s\S]*/gi, '');

    out = json.convertRawJson(out);
    if (rx.payloadLabel) out = out.replace(rx.payloadLabel, '');
    if (rx.inlineLabels) out = out.replace(rx.inlineLabels, ' ');
    if (rx.lineLabels) out = out.replace(rx.lineLabels, '$1\n');
    out = json.convertInlineJson(out);

    if (rx.boundary) {
      const matches = [...out.matchAll(rx.boundary)];
      if (matches.length) {
        const last = matches[matches.length - 1];
        out = out.slice(last.index + last[0].length);
      }
    }
    if (rx.labelledBlock) out = out.replace(rx.labelledBlock, '');
    if (rx.planning) out = out.replace(rx.planning, '');
    if (rx.filler) out = out.replace(rx.filler, '');
    if (rx.annotation) out = out.replace(rx.annotation, '');
    if (rx.headingAlone) out = out.replace(rx.headingAlone, '');
    if (rx.headingLead) out = out.replace(rx.headingLead, '');

    /* Closings stack ("Need anything else? Don't hesitate to ask."): one pass
       left the first one standing. Bounded, so a reply made only of phrases
       that look robotic cannot be eaten whole by a loop. */
    if (rx.closing) {
      for (let i = 0; i < maxClosingPasses; i += 1) {
        const next = out.replace(rx.closing, '');
        if (next === out) break;
        out = next;
      }
    }
    if (rx.openers) out = out.replace(rx.openers, '\n');

    out = out.replace(/\n{3,}/g, '\n\n');
    out = out.replace(/[ \t]{2,}/g, ' ');
    return out.trim();
  }

  return {
    clean,
    /** Converts a parsed JSON value to prose without any key (for tool results shown as text). */
    jsonToProse: (value, language) => forLanguage(language).json.jsonToProse(value, 0),
    languages: Object.keys(languages)
  };
}

module.exports = { createResponseCleaner };
