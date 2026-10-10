/**
 * Une réponse qui arrive petit à petit (`stream`) : le texte est montré pendant qu'il s'écrit.
 *
 *   - readServerEvents lit les événements d'un corps `text/event-stream` (lignes `data:`), un objet JSON chacun ;
 *   - visibleSoFar dit ce qu'on peut montrer du texte reçu jusqu'ici : jamais la réflexion entre balises think
 *     (même pas encore fermée), jamais une balise coupée en deux, et rien du tout quand le modèle écrit un appel
 *     d'outil dans son texte (<tool_call>, <function=…>) ou commence par du JSON.
 *
 * `onText` reçoit toujours le texte ENTIER montré jusqu'ici (pas un morceau) : quand le routeur passe au modèle
 * suivant, le texte repart de zéro et remplace le précédent, sans rien à recoller.
 */

const { withoutThinking } = require('./modelAnswers');

const WRITTEN_CALL = /<tool_call>|<function=/;

async function readServerEvents(response, onEvent) {
  const body = response && response.body;
  if (!body || typeof body.getReader !== 'function') {
    /* Un corps sans flux (un double de test, un relais qui a tout gardé) : lu d'un coup. */
    const text = typeof response.text === 'function' ? await response.text() : '';
    for (const line of text.split(/\r?\n/)) readLine(line, onEvent);
    return;
  }
  const reader = body.getReader();
  const decoder = new globalThis.TextDecoder();
  let pending = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      readLine(pending.slice(0, end), onEvent);
      pending = pending.slice(end + 1);
    }
  }
  pending += decoder.decode();
  if (pending) readLine(pending, onEvent);
}

function readLine(raw, onEvent) {
  const line = raw.replace(/\r$/, '');
  if (!line.startsWith('data:')) return;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return;
  let event;
  try {
    event = JSON.parse(data);
  } catch (_error) {
    return;
  }
  onEvent(event);
}

function visibleSoFar(raw) {
  const text = String(raw || '');
  if (WRITTEN_CALL.test(text)) return '';
  let shown = withoutThinking(text);
  /* Une balise pas encore fermée en fin de texte (« <thi », « <tool_c ») : attendue avant d'être montrée. */
  const open = shown.lastIndexOf('<');
  if (open >= 0 && !shown.includes('>', open)) shown = shown.slice(0, open).trimEnd();
  if (/^[[{]/.test(shown)) return '';
  return shown;
}

/** Un `onText` qui ne prévient que quand le texte montré change, et qui ne lève jamais chez l'appelant. */
function textReporter(onText) {
  if (typeof onText !== 'function') return null;
  let last = '';
  return (raw) => {
    const shown = visibleSoFar(raw);
    if (shown === last) return;
    last = shown;
    try {
      onText(shown);
    } catch (_error) {
      /* L'affichage d'un morceau n'arrête jamais la réponse. */
    }
  };
}

module.exports = { readServerEvents, visibleSoFar, textReporter };
