/**
 * Reading what a model returns after a conversation, and the default request
 * made to it. The request is an instruction to a model, never shown to a
 * person; pass `consolidationPrompt` to write your own.
 */

/*
 * A model's answer is read as leniently as it can be without inventing
 * anything. Syntax first: a code fence or a sentence around the JSON, raw line
 * breaks inside its strings, a comma before a closing bracket.
 */
function repairJson(text) {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') {
        out += char + (text[index + 1] ?? '');
        index += 1;
        continue;
      }
      if (char === '"') inString = false;
      else if (char === '\n') { out += '\\n'; continue; }
      else if (char === '\r') continue;
      else if (char === '\t') { out += '\\t'; continue; }
      out += char;
      continue;
    }
    if (char === '"') inString = true;
    out += char;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function parseLoosely(text) {
  for (const candidate of [text, repairJson(text)]) {
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      /* The next reading. */
    }
  }
  return undefined;
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/*
 * Models wrap their JSON in a code fence, or say a word around it: the outer
 * object alone is read. Anything else throws — the caller treats it as a
 * failed run, never as "nothing to remember".
 */
function parseModelJson(value) {
  const text = String(value ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new SyntaxError('The model answer holds no JSON object.');
  const parsed = parseLoosely(text.slice(start, end + 1));
  if (parsed === undefined) throw new SyntaxError('The model answer holds no readable JSON.');
  if (!isObject(parsed)) throw new TypeError('The model answer is not an object.');
  return parsed;
}

/* Every whole {...} in the text, even when what holds them was cut short. */
function wholeObjects(text) {
  const found = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (char === '\\') index += 1;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        const parsed = parseLoosely(text.slice(start, index + 1));
        if (isObject(parsed)) found.push(parsed);
        break;
      }
    }
  }
  return found;
}

/* The answer as an object with facts, corrections and summary, or null when nothing can be read in it. */
function answerOf(value) {
  const text = String(value ?? '');
  const open = text.indexOf('{');
  const bracket = text.indexOf('[');
  /* A list that comes before the first object is the list of facts itself. */
  const list = bracket === -1 || (open !== -1 && open < bracket) ? undefined : parseLoosely(text.slice(bracket, text.lastIndexOf(']') + 1));
  if (Array.isArray(list)) return { facts: list };
  const whole = open === -1 ? undefined : parseLoosely(text.slice(open, text.lastIndexOf('}') + 1));
  if (isObject(whole)) return whole;
  if (open === -1) return null;
  /* Cut short: the objects that are whole, a summary if it was written before the cut. */
  const objects = wholeObjects(text.slice(open));
  const summary = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  if (!objects.length && summary === undefined) return null;
  return {
    facts: objects.filter((item) => !('id' in item)),
    corrections: objects.filter((item) => 'id' in item),
    ...(summary === undefined ? {} : { summary: parseLoosely(`"${summary}"`) ?? summary })
  };
}

const listOf = (value) => (Array.isArray(value) ? value : []);
const oneLine = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/* A fact as a string, or as an object whose text, kind and importance go by the names models give them. */
function factOf(item) {
  const raw = typeof item === 'string' ? { text: item } : item;
  if (!isObject(raw)) return null;
  const text = oneLine(raw.text ?? raw.fact ?? raw.memory ?? raw.content);
  if (!text) return null;
  return { text, kind: raw.kind ?? raw.type ?? raw.category, importance: raw.importance ?? raw.priority };
}

/**
 * The facts, the corrections and the summary of a model's answer. Throws when
 * nothing can be read in it. Read as models really answer: a code fence or a
 * sentence around the JSON, raw line breaks in strings, a trailing comma, a
 * bare list of facts, facts as plain strings, `memories` or `new_facts` for
 * `facts`, `updates` for `corrections`, `fact`/`memory`/`content` for `text`,
 * `type`/`category` for `kind`, `priority` for `importance`, and an answer
 * stopped half way (each whole fact before the cut is kept).
 *
 * Kind and importance are returned as the model wrote them: `remember()` and
 * `update()` normalize them. The summary may be missing (null): the facts are
 * kept all the same.
 *
 * @returns {{ facts: Array<{text: string, kind: unknown, importance: unknown}>,
 *             corrections: Array<{id: string, text: string, kind: unknown, importance: unknown}>,
 *             summary: string | null }}
 */
function readExtraction(value) {
  const parsed = answerOf(value);
  if (!parsed) throw new SyntaxError('The model answer holds nothing readable.');
  const facts = listOf(parsed.facts ?? parsed.memories ?? parsed.new_facts).map(factOf).filter(Boolean);
  const corrections = listOf(parsed.corrections ?? parsed.updates).flatMap((item) => {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const fact = id ? factOf(item) : null;
    return fact ? [{ id, ...fact }] : [];
  });
  return { facts, corrections, summary: oneLine(parsed.summary) || null };
}

/**
 * @param {object} input
 * @param {string[]} input.kinds
 * @param {Array<{id: string, text: string}>} input.known  already masked.
 * @param {string} input.transcript                        already masked.
 * @param {string} [input.language]
 * @param {string} [input.role]
 * @returns {{ system: string, prompt: string }}
 */
function defaultConsolidationPrompt({ kinds, known, transcript, language, role }) {
  const system = [
    'Extract durable memories about the person from this conversation, and summarize the episode.',
    'Return JSON only, shaped exactly as',
    `{"facts":[{"text":"...","kind":"${kinds.join('|')}","importance":3}],"corrections":[{"id":"...","text":"..."}],"summary":"..."}.`,
    'Keep each fact short and self-contained. Importance is an integer from 1 to 5.',
    'When the conversation shows that a known memory is no longer right, put it in corrections with its id and the right text, and do not repeat it in facts.',
    'Do not put in facts what is already known. Never reveal masked data.',
    ...(role ? [`The person's role is: ${role}.`] : []),
    ...(language ? [`Write facts and the summary in the language whose code is "${language}".`] : [])
  ].join('\n');
  const prompt = [
    ...(known.length ? ['--- ALREADY KNOWN ---', ...known.map((row) => `${row.id}: ${row.text}`), '--- END ---'] : []),
    '--- CONVERSATION ---',
    transcript,
    '--- END ---'
  ].join('\n');
  return { system, prompt };
}

/* A transcript is a string, or turns { role, text } joined one per line. */
function transcriptText(transcript) {
  if (typeof transcript === 'string') return transcript;
  if (!Array.isArray(transcript)) return '';
  return transcript
    .map((turn) => (turn && typeof turn === 'object' ? `${turn.role || 'user'}: ${turn.text ?? turn.content ?? ''}` : String(turn ?? '')))
    .join('\n');
}

module.exports = {
  parseModelJson,
  readExtraction,
  defaultConsolidationPrompt,
  transcriptText
};
