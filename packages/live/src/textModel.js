'use strict';

async function* parseSse(stream) {
  const decoder = new globalThis.TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, {
      stream: true
    });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
      if (data) {
        try {
          yield JSON.parse(data);
        } catch (_error) {/* Skip a malformed event. */}
      }
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }
  buffer += decoder.decode();
  const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
  if (data) {
    try {
      yield JSON.parse(data);
    } catch (_error) {/* Skip a malformed final event. */}
  }
}
function createGeminiTextModel({
  fetch,
  candidates = [],
  endpoint = 'https://generativelanguage.googleapis.com/v1beta',
  clock,
  timeoutMs = 20000,
  cooldownMs = 600000,
  generationConfig = {},
  logger = {}
}) {
  if (typeof fetch !== 'function' || !clock) throw new TypeError('TEXT_MODEL_DEPENDENCY_REQUIRED');
  const resting = new Map();
  return {
    async generate({
      instructions,
      contents,
      declarations = [],
      signal,
      onText = () => {}
    }) {
      const ordered = [
        ...candidates.filter(item => (resting.get(item.key) || 0) <= clock.now()),
        ...candidates.filter(item => (resting.get(item.key) || 0) > clock.now())
      ];
      for (const candidate of ordered) {
        if (signal?.aborted) return {
          parts: [],
          interrupted: true
        };
        const controller = new globalThis.AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener?.('abort', abort, {
          once: true
        });
        const timer = clock.setTimeout(abort, timeoutMs);
        const parts = [];
        let started = false;
        try {
          const response = await fetch(`${endpoint}/models/${encodeURIComponent(candidate.model)}:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': candidate.key
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{
                  text: instructions
                }]
              },
              contents,
              ...(declarations.length ? {
                tools: [{
                  functionDeclarations: declarations
                }]
              } : {}),
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 1024,
                ...generationConfig
              }
            }),
            signal: controller.signal
          });
          if (!response.ok) {
            if ([400, 401, 403, 429].includes(response.status)) resting.set(candidate.key, clock.now() + cooldownMs);
            continue;
          }
          for await (const event of parseSse(response.body)) {
            for (const part of event.candidates?.[0]?.content?.parts || []) {
              parts.push(part);
              if (typeof part.text === 'string' && !part.thought) {
                started = true;
                onText(part.text);
              }
            }
          }
          return {
            parts,
            interrupted: Boolean(signal?.aborted)
          };
        } catch (error) {
          if (signal?.aborted) return {
            parts,
            interrupted: true
          };
          if (started) return {
            parts,
            interrupted: false
          };
          logger.warn?.('TEXT_PROVIDER_FAILED', {
            code: error?.code
          });
        } finally {
          clock.clearTimeout(timer);
          signal?.removeEventListener?.('abort', abort);
        }
      }
      throw Object.assign(new Error('TEXT_MODEL_UNAVAILABLE'), {
        code: 'TEXT_MODEL_UNAVAILABLE'
      });
    }
  };
}
function createTextThinker({
  model,
  instructions,
  declarations = [],
  tools,
  earlier = [],
  maxTurns = 6,
  maxHistory = 40,
  onTool = () => {}
}) {
  if (!model?.generate) throw new TypeError('TEXT_MODEL_REQUIRED');
  let history = [];
  for (const turn of earlier) {
    const role = turn.who === 'person' || turn.role === 'user' ? 'user' : 'model';
    const text = String(turn.text || '').trim();
    if (!text) continue;
    const last = history.at(-1);
    if (last?.role === role) last.parts[0].text += `\n${text}`;else history.push({
      role,
      parts: [{
        text
      }]
    });
  }
  if (history[0]?.role === 'model') history.shift();
  let lastStart = null;
  function trim() {
    if (history.length <= maxHistory) return;
    let at = history.length - maxHistory;
    while (at < history.length && !(history[at].role === 'user' && history[at].parts[0]?.text !== undefined)) at += 1;
    history = history.slice(at);
  }
  return {
    async respond(question, {
      onText = () => {},
      signal
    } = {}) {
      lastStart = history.length;
      history.push({
        role: 'user',
        parts: [{
          text: question
        }]
      });
      let spoken = '';
      for (let turn = 0; turn < maxTurns; turn += 1) {
        let result;
        let streamed = false;
        try {
          result = await model.generate({
            instructions,
            contents: history,
            declarations,
            signal,
            onText: part => {
              streamed = true;
              spoken += part;
              onText(part);
            }
          });
        } catch (error) {
          history.splice(lastStart);
          throw error;
        }
        const parts = result.parts || [];
        if (!streamed) for (const part of parts) if (typeof part.text === 'string' && !part.thought) {
          spoken += part.text;
          onText(part.text);
        }
        const interrupted = Boolean(result.interrupted);
        const calls = interrupted ? [] : parts.filter(part => part.functionCall).map(part => part.functionCall);
        if (parts.length) {
          const text = parts.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('');
          const retained = calls.length && !interrupted ? parts : [...(text ? [{
            text: interrupted ? `${text}…` : text
          }] : []), ...parts.filter(part => typeof part.text !== 'string')];
          history.push({
            role: 'model',
            parts: retained
          });
        }
        if (!calls.length) {
          trim();
          return {
            text: spoken,
            interrupted
          };
        }
        const responses = await Promise.all(calls.map(async call => {
          onTool(call.name, 'start');
          let result;
          try {
            result = await tools.call({
              id: call.id,
              name: call.name,
              args: call.args || {}
            });
          } catch (_error) {
            result = {
              code: 'TOOL_FAILED'
            };
          }
          onTool(call.name, 'end');
          return {
            functionResponse: {
              ...(call.id ? {
                id: call.id
              } : {}),
              name: call.name,
              response: {
                result
              }
            }
          };
        }));
        history.push({
          role: 'user',
          parts: responses
        });
        if (signal?.aborted) {
          trim();
          return {
            text: spoken,
            interrupted: true
          };
        }
      }
      trim();
      return {
        text: spoken,
        interrupted: false,
        limitReached: true
      };
    },
    undoLast() {
      if (lastStart !== null) history.splice(lastStart);
      lastStart = null;
    },
    get history() {
      return history.map(turn => ({
        role: turn.role,
        parts: turn.parts.map(part => ({
          ...part
        }))
      }));
    }
  };
}
module.exports = {
  parseSse,
  createGeminiTextModel,
  createTextThinker
};
