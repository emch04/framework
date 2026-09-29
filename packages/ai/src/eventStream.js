/**
 * Le travail d'un agent envoyé à l'app au fil de l'eau (server-sent events) :
 * un bloc par évènement, "event: <type>\ndata: <json>\n\n".
 *
 * Quand la personne part avant la fin, `signal` s'interrompt pour que le
 * travail s'arrête aussi ; un flux fermé par le serveur n'est pas un départ.
 * Écrire après la fin ne fait rien : le travail qui finissait ne plante pas.
 */

const HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  /* Un proxy devant (nginx) retiendrait sinon les évènements jusqu'à la fin. */
  'X-Accel-Buffering': 'no'
};

/**
 * @param {import('http').ServerResponse} res  une réponse Node (Express compris).
 * @param {object} [options]
 * @param {Record<string, string>} [options.headers] ajoutés à ceux du flux.
 * @returns {{ send: (type: string, data: unknown) => void, close: () => void, signal: AbortSignal }}
 */
function openEventStream(res, options = {}) {
  if (!res || typeof res.write !== 'function' || typeof res.setHeader !== 'function') {
    throw new Error('openEventStream requires a Node.js ServerResponse.');
  }
  const left = new globalThis.AbortController();
  res.statusCode = 200;
  for (const [name, value] of Object.entries({ ...HEADERS, ...(options.headers || {}) })) res.setHeader(name, value);
  res.flushHeaders();
  res.on('close', () => {
    if (!res.writableEnded) left.abort();
  });
  const open = () => !res.writableEnded && !left.signal.aborted;
  return {
    signal: left.signal,
    send(type, data) {
      if (open()) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (open()) res.end();
    }
  };
}

module.exports = { openEventStream, EVENT_STREAM_HEADERS: HEADERS };
