/**
 * Reading what a model returns after a conversation, and the default request
 * made to it. The request is an instruction to a model, never shown to a
 * person; pass `consolidationPrompt` to write your own.
 */

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
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('The model answer is not an object.');
  return parsed;
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
  defaultConsolidationPrompt,
  transcriptText
};
