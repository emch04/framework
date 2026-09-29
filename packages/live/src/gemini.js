'use strict';

const DEFAULT_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
function geminiSetup({
  model,
  voice,
  instructions,
  declarations = [],
  handle = null,
  mode = 'normal'
}) {
  return {
    setup: {
      model: `models/${model}`,
      ...(declarations.length ? {
        tools: [{
          functionDeclarations: declarations
        }]
      } : {}),
      generationConfig: mode === 'confidential' ? {
        responseModalities: ['TEXT']
      } : {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice
            }
          }
        }
      },
      systemInstruction: {
        parts: [{
          text: instructions
        }]
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: handle ? {
        handle
      } : {},
      contextWindowCompression: {
        slidingWindow: {}
      },
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
          prefixPaddingMs: 300
        }
      }
    }
  };
}
function geminiEvents(message) {
  const events = [];
  if (message.sessionResumptionUpdate?.newHandle && message.sessionResumptionUpdate.resumable !== false) events.push({
    type: 'handle',
    handle: message.sessionResumptionUpdate.newHandle
  });
  if (message.goAway) events.push({
    type: 'goAway'
  });
  if (message.toolCall?.functionCalls) events.push({
    type: 'tools',
    calls: message.toolCall.functionCalls
  });
  if (message.toolCallCancellation?.ids) events.push({
    type: 'toolCancel',
    ids: message.toolCallCancellation.ids
  });
  const content = message.serverContent;
  /* In the order it is heard: the voice first, then what is written of it, then the end of what it said. */
  for (const part of content?.modelTurn?.parts || []) {
    if (part.inlineData?.data) events.push({
      type: 'audio',
      data: part.inlineData.data,
      mimeType: part.inlineData.mimeType
    });
    if (part.text) events.push({
      type: 'text',
      text: part.text
    });
  }
  if (content?.inputTranscription?.text) events.push({
    type: 'heard',
    text: content.inputTranscription.text
  });
  if (content?.outputTranscription?.text) events.push({
    type: 'said',
    text: content.outputTranscription.text
  });
  if (content?.interrupted) events.push({
    type: 'interrupted'
  });
  if (content?.turnComplete) events.push({
    type: 'turn'
  });
  if (message.error) events.push({
    type: 'error',
    code: message.error.code || 'PROVIDER_ERROR'
  });
  return events;
}
/* What Google says when a session is refused or cut for a key or a quota (or 1008, policy violation): the next key, not the same one again. */
const GAVE_OUT = /quota|exhausted|rate|limit|api key|permission|billing|unauthori[sz]ed|forbidden|not found|not supported/i;
function defaultGaveOut({ code, reason }) {
  return code === 1008 || GAVE_OUT.test(String(reason || ''));
}
/* What a session that knows nothing is told: the latest part of what was said, one line a turn. */
function defaultHandover({ kind, turns, maxChars = 6000 }) {
  const text = turns.map(turn => `${turn.who}: ${String(turn.text).trim()}`).join('\n');
  return {
    text: text.length > maxChars ? `…${text.slice(-maxChars)}` : text,
    /* Picking up a conversation, the assistant speaks first; on another line of the same call, it waits for the person. */
    turnComplete: kind === 'resume'
  };
}
function createGeminiLiveAdapter({
  websocketFactory,
  candidates = [],
  endpoint = DEFAULT_ENDPOINT,
  voice,
  clock,
  openTimeoutMs = 10000,
  cooldownMs = 600000,
  maxHeld = 200,
  maxImageBytes = 200000,
  maxImageChars = Math.ceil(maxImageBytes * 4 / 3) + 4,
  imageEveryMs = 1000,
  gaveOut = defaultGaveOut,
  handover = defaultHandover,
  toolError = () => ({
    result: {
      code: 'TOOL_FAILED'
    }
  }),
  logger = {}
}) {
  if (typeof websocketFactory !== 'function' || !clock) throw new TypeError('ADAPTER_DEPENDENCY_REQUIRED');
  const resting = new Map();
  /* `candidates` may be a function: the keys of a host that reloads them are read again at every change of line. */
  function ordered() {
    const available = (typeof candidates === 'function' ? candidates() : candidates).filter(candidate => candidate?.key && candidate?.model);
    return [...available.filter(item => (resting.get(item.key) || 0) <= clock.now()), ...available.filter(item => (resting.get(item.key) || 0) > clock.now())];
  }
  return {
    async connect({
      instructions,
      tools = {
        declarations: [],
        call: async () => ({})
      },
      earlier = [],
      getHistory,
      mode = 'normal',
      onEvent = () => {},
      onClose = () => {}
    }) {
      let socket = null;
      let current = null;
      let handle = null;
      let ended = false;
      let moving = false;
      let generation = 0;
      let lastImageAt = -Infinity;
      const held = [];
      /* What was tried since the last line that opened: once one opens, the others may be tried again at the next change. */
      let tried = new Set();
      const cancelled = new Set();
      const send = value => {
        if (socket?.readyState === 1) socket.send(JSON.stringify(value));
      };
      /* A session that knows nothing is told what was said: the conversation the call goes on with, or the call so far on another line. */
      const tell = kind => {
        const turns = kind === 'resume' || typeof getHistory !== 'function' ? earlier : getHistory();
        const { text, turnComplete } = handover({
          kind,
          turns
        });
        if (text) send({
          clientContent: {
            turns: [{
              role: 'user',
              parts: [{
                text
              }]
            }],
            turnComplete: Boolean(turnComplete)
          }
        });
      };
      /* A tool Google asks for: run by the host, its result given back to the session that asked (one that took over never asked). */
      async function runTools(calls, source) {
        await Promise.all(calls.map(async call => {
          onEvent({
            type: 'tool',
            name: call.name
          });
          let response;
          try {
            response = {
              result: await tools.call({
                id: call.id,
                name: call.name,
                args: call.args || {}
              })
            };
          } catch (error) {
            response = toolError(error);
          }
          onEvent({
            type: 'tool_done',
            name: call.name
          });
          if (!cancelled.has(call.id) && source === socket) send({
            toolResponse: {
              functionResponses: [{
                id: call.id,
                name: call.name,
                response
              }]
            }
          });
        }));
      }
      function routeEvents(raw, source) {
        let parsed;
        try {
          parsed = JSON.parse(String(raw));
        } catch (_error) {
          return;
        }
        for (const event of geminiEvents(parsed)) {
          if (event.type === 'handle') handle = event.handle;else if (event.type === 'goAway') {
            if (source === socket) void move(Boolean(handle));
          } else if (event.type === 'toolCancel') event.ids.forEach(id => cancelled.add(id));else if (event.type === 'tools') void runTools(event.calls, source);else onEvent(event);
        }
      }
      function open(candidate, resume) {
        return new Promise((resolve, reject) => {
          const next = websocketFactory(`${endpoint}?key=${encodeURIComponent(candidate.key)}`);
          let ready = false;
          let settled = false;
          const fail = (code, closed = {}) => {
            if (settled) return;
            settled = true;
            clock.clearTimeout(timer);
            reject(Object.assign(new Error(code), {
              code,
              ...closed
            }));
          };
          const timer = clock.setTimeout(() => {
            next.terminate?.();
            fail('OPEN_TIMEOUT');
          }, openTimeoutMs);
          next.on('open', () => next.send(JSON.stringify(geminiSetup({
            model: candidate.model,
            voice,
            instructions,
            declarations: tools.declarations,
            handle: resume ? handle : null,
            mode
          }))));
          next.on('message', data => {
            let parsed;
            try {
              parsed = JSON.parse(String(data));
            } catch (_error) {
              return;
            }
            if (!ready && parsed.setupComplete) {
              ready = true;
              settled = true;
              clock.clearTimeout(timer);
              resolve(next);
            } else if (ready && next === socket) routeEvents(data, next);
          });
          next.on('close', (code, reason) => {
            const closed = {
              closeCode: code,
              reason: String(reason || '')
            };
            if (!ready) fail('OPEN_CLOSED', closed);else if (next === socket && !ended && !moving) {
              /* A key or quota problem: this key rests and the next one takes over; otherwise the same key picks the line up again. */
              const out = gaveOut(closed.closeCode === undefined ? {
                reason: closed.reason
              } : {
                code: closed.closeCode,
                reason: closed.reason
              });
              if (out) resting.set(candidate.key, clock.now() + cooldownMs);
              void move(!out && Boolean(handle));
            }
          });
          next.on('error', () => {
            if (!ready) fail('OPEN_ERROR');
          });
        });
      }
      /* Opens the next session: first the same one (with its handle) when asked, then every model and key not tried yet. All failing: the call ends. */
      async function move(resume) {
        if (ended || moving) return;
        moving = true;
        const previous = socket;
        socket = null;
        if (previous) onEvent({
          type: 'switching'
        });
        if (previous) previous.close?.();
        const available = ordered();
        for (const candidate of available) {
          const id = `${candidate.model}:${candidate.key}`;
          const resumeHere = Boolean(resume && handle && current && candidate.key === current.key && candidate.model === current.model);
          if (tried.has(id) && !resumeHere) continue;
          tried.add(id);
          try {
            const next = await open(candidate, resumeHere);
            if (ended) {
              next.close?.();
              break;
            }
            socket = next;
            const first = generation === 0;
            current = candidate;
            generation += 1;
            /* A session that took over on another line remembers nothing of the last one's handle. */
            if (!resumeHere) {
              handle = null;
              if (first ? earlier.length : true) tell(first ? 'resume' : 'switch');
            }
            tried = new Set([id, ...(resumeHere ? tried : [])]);
            while (held.length) send(held.shift());
            onEvent({
              type: 'ready',
              model: candidate.model,
              reconnected: generation > 1
            });
            moving = false;
            return;
          } catch (error) {
            logger.warn?.('PROVIDER_CONNECT_FAILED', {
              code: error.code
            });
            if (gaveOut({
              code: error.closeCode,
              reason: error.reason
            })) resting.set(candidate.key, clock.now() + cooldownMs);
          }
        }
        moving = false;
        if (!ended) onClose('PROVIDER_UNAVAILABLE');
      }
      await move(false);
      return {
        sendAudio(data, mimeType = 'audio/pcm;rate=16000') {
          const message = {
            realtimeInput: {
              audio: {
                data,
                mimeType
              }
            }
          };
          if (socket) send(message);else if (held.length < maxHeld) held.push(message);
        },
        sendText(text) {
          const message = {
            clientContent: {
              turns: [{
                role: 'user',
                parts: [{
                  text
                }]
              }],
              turnComplete: true
            }
          };
          if (socket) send(message);else if (held.length < maxHeld) held.push(message);
        },
        sendImage(data) {
          if (typeof data !== 'string' || data.length > maxImageChars || !socket || clock.now() - lastImageAt < imageEveryMs) return false;
          lastImageAt = clock.now();
          send({
            realtimeInput: {
              video: {
                data,
                mimeType: 'image/jpeg'
              }
            }
          });
          return true;
        },
        mute() {
          send({
            realtimeInput: {
              audioStreamEnd: true
            }
          });
        },
        interrupt() {
          send({
            clientContent: {
              turnComplete: true
            }
          });
        },
        close() {
          ended = true;
          held.length = 0;
          socket?.close?.();
          socket = null;
        },
        get model() {
          return current?.model || null;
        }
      };
    }
  };
}
module.exports = {
  geminiSetup,
  geminiEvents,
  createGeminiLiveAdapter
};
