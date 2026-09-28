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
  if (message.sessionResumptionUpdate?.newHandle) events.push({
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
  if (content?.inputTranscription?.text) events.push({
    type: 'heard',
    text: content.inputTranscription.text
  });
  if (content?.outputTranscription?.text) events.push({
    type: 'said',
    text: content.outputTranscription.text
  });
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
  imageEveryMs = 1000,
  logger = {}
}) {
  if (typeof websocketFactory !== 'function' || !clock) throw new TypeError('ADAPTER_DEPENDENCY_REQUIRED');
  const resting = new Map();
  function ordered() {
    const available = candidates.filter(candidate => candidate?.key && candidate?.model);
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
      const tried = new Set();
      const cancelled = new Set();
      const send = value => {
        if (socket?.readyState === 1) socket.send(JSON.stringify(value));
      };
      const tell = () => {
        const history = typeof getHistory === 'function' ? getHistory() : earlier;
        const text = history.map(turn => `${turn.who}: ${String(turn.text).trim()}`).join('\n').slice(-6000);
        if (text) send({
          clientContent: {
            turns: [{
              role: 'user',
              parts: [{
                text
              }]
            }],
            turnComplete: true
          }
        });
      };
      async function routeEvents(raw, source) {
        let parsed;
        try {
          parsed = JSON.parse(String(raw));
        } catch (_error) {
          return;
        }
        for (const event of geminiEvents(parsed)) {
          if (event.type === 'handle') handle = event.handle;else if (event.type === 'goAway') {
            if (source === socket) void move(Boolean(handle));
          } else if (event.type === 'toolCancel') event.ids.forEach(id => cancelled.add(id));else if (event.type === 'tools') {
            for (const call of event.calls) {
              onEvent({
                type: 'tool',
                name: call.name
              });
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
              onEvent({
                type: 'tool_done',
                name: call.name
              });
              if (!cancelled.has(call.id) && source === socket) send({
                toolResponse: {
                  functionResponses: [{
                    id: call.id,
                    name: call.name,
                    response: {
                      result
                    }
                  }]
                }
              });
            }
          } else onEvent(event);
        }
      }
      function open(candidate, resume) {
        return new Promise((resolve, reject) => {
          const next = websocketFactory(`${endpoint}?key=${encodeURIComponent(candidate.key)}`);
          let ready = false;
          let settled = false;
          const fail = code => {
            if (settled) return;
            settled = true;
            clock.clearTimeout(timer);
            reject(Object.assign(new Error(code), {
              code
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
            } else if (ready && next === socket) void routeEvents(data, next);
          });
          next.on('close', code => {
            if (!ready) fail('OPEN_CLOSED');else if (next === socket && !ended && !moving) {
              if (code === 1008) resting.set(candidate.key, clock.now() + cooldownMs);
              void move(code !== 1008 && Boolean(handle));
            }
          });
          next.on('error', () => {
            if (!ready) fail('OPEN_ERROR');
          });
        });
      }
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
          if (tried.has(id) && !(resume && handle && current && candidate.key === current.key && candidate.model === current.model)) continue;
          tried.add(id);
          try {
            const next = await open(candidate, resume && Boolean(handle) && candidate.key === current?.key);
            if (ended) {
              next.close?.();
              break;
            }
            socket = next;
            const changed = Boolean(current && (candidate.key !== current.key || candidate.model !== current.model));
            current = candidate;
            generation += 1;
            if (changed || generation > 1 && !resume) tell();
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
            resting.set(candidate.key, clock.now() + cooldownMs);
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
          if (typeof data !== 'string' || data.length > maxImageBytes * 4 / 3 + 4 || clock.now() - lastImageAt < imageEveryMs) return false;
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
