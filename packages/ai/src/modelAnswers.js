/**
 * Lire la réponse d'un modèle, quel que soit le fournisseur (format OpenAI,
 * Gemini…) : son raisonnement retiré, ses appels d'outil lus — y compris ceux
 * qu'il a écrits dans son texte au lieu de les demander —, et ce que le
 * fournisseur rend au routeur. Module interne : les adaptateurs le partagent.
 */

/**
 * Le raisonnement d'un modèle écrit entre balises think n'est jamais montré.
 * Un raisonnement resté ouvert (réponse coupée à sa longueur) part jusqu'à la
 * fin ; une balise fermante sans ouvrante (un gabarit qui l'a ouverte lui-même)
 * emporte tout ce qui la précède.
 */
function withoutThinking(content) {
  let text = String(content === null || content === undefined ? '' : content).replace(/<think>[\s\S]*?<\/think>/gi, '');
  const closing = text.toLowerCase().lastIndexOf('</think>');
  if (closing >= 0) text = text.slice(closing + '</think>'.length);
  const opening = text.toLowerCase().indexOf('<think>');
  if (opening >= 0) text = text.slice(0, opening);
  return text.trim();
}

/* Un appel d'outil écrit dans le texte au lieu d'être demandé (façons de Qwen et de Hermes). */
const WRITTEN_CALL = /<tool_call>|<function=/;

/** Une valeur telle que le modèle l'a écrite : du JSON quand c'en est (un nombre, une liste), les mots sinon. */
function writtenValue(written) {
  const text = written.trim();
  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

/**
 * Les appels d'outil écrits en texte, relus en vrais appels :
 * <function=nom><parameter=clé>valeur</parameter></function>, ou un JSON
 * {"name", "arguments"} entre balises <tool_call>. Ce qui ne se relit pas
 * proprement est laissé de côté.
 * @returns {{ id: string, name: string, args: object }[]}
 */
function readWrittenToolCalls(text) {
  const calls = [];
  for (const [, name, body] of String(text || '').matchAll(/<function=([\w.-]+)>([\s\S]*?)<\/function>/g)) {
    const args = Object.fromEntries([...body.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)].map(([, key, value]) => [key, writtenValue(value)]));
    calls.push({ name, args });
  }
  for (const [, body] of String(text || '').matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g)) {
    try {
      const { name, arguments: args } = JSON.parse(body);
      const parsed = typeof args === 'string' ? JSON.parse(args) : args;
      if (typeof name === 'string' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) calls.push({ name, args: parsed });
    } catch (_error) {
      /* Illisible : laissé de côté. */
    }
  }
  return calls.map((call, index) => ({ id: `written-${index + 1}`, ...call }));
}

/**
 * Une réponse en texte qui contient un appel écrit n'est JAMAIS une réponse à
 * montrer : ses appels lisibles deviennent de vrais appels quand des outils
 * étaient proposés, sinon il ne reste rien (le routeur passe au modèle suivant).
 */
function readWrittenAnswer(text, toolsOffered) {
  if (!WRITTEN_CALL.test(text || '')) return null;
  return { text: null, toolCalls: toolsOffered ? readWrittenToolCalls(text) : [] };
}

/**
 * Tool arguments as an object, or null with `invalid: true` for anything else.
 * `reason` dit pourquoi ('not_json' : texte illisible, `detail` porte l'erreur
 * de lecture ; 'not_object' : du JSON, mais pas un objet) — de quoi dire au
 * modèle quoi corriger quand il redemande l'outil.
 */
function readToolArguments(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return { args: {}, invalid: false };
  if (typeof raw === 'object') {
    return Array.isArray(raw) ? { args: null, invalid: true, reason: 'not_object' } : { args: raw, invalid: false };
  }
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { args: parsed, invalid: false } : { args: null, invalid: true, reason: 'not_object' };
  } catch (error) {
    return { args: null, invalid: true, reason: 'not_json', detail: error.message };
  }
}

/** Un appel d'outil lu : ses arguments, et quand ils sont illisibles, pourquoi. */
function toolCallOf(id, name, rawArguments) {
  const { args, invalid, reason, detail } = readToolArguments(rawArguments);
  return {
    id,
    name,
    args,
    ...(invalid ? { invalid: true, invalidReason: reason, ...(detail ? { invalidDetail: detail } : {}) } : {})
  };
}

/** What a provider hands the router: a failure carries its status (never the key). */
function providerResult(id, answer, detailed) {
  if (answer.status < 200 || answer.status >= 300) {
    /* The status reaches the router (429 → cooldown); the key never does. */
    const failure = new Error(`Provider "${id}" answered ${answer.status}.`);
    failure.statusCode = answer.status;
    throw failure;
  }
  if (detailed) return { text: answer.text === undefined ? null : answer.text, toolCalls: answer.toolCalls || [], cut: Boolean(answer.cut) };
  if (answer.toolCalls && answer.toolCalls.length) return { toolCalls: answer.toolCalls };
  if (!answer.text) {
    const empty = new Error(`Provider "${id}" gave no text.`);
    empty.statusCode = 502;
    throw empty;
  }
  return answer.text;
}

module.exports = { withoutThinking, readWrittenToolCalls, readWrittenAnswer, readToolArguments, toolCallOf, providerResult };
