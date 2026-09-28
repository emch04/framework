'use strict';

const voice = require('@astratra/voice');
const {
  createGeminiLiveAdapter
} = require('./gemini');
function createLiveReader({
  primary = null,
  providers = [],
  maxConcurrent = 1,
  drift = {},
  logger = {}
} = {}) {
  const fallback = voice.createPieceVoiceService({
    providers,
    maxConcurrent
  });
  let generation = 0;
  let closed = false;
  return {
    async synthesize({
      text,
      language,
      signal,
      onPiece,
      onReset
    } = {}) {
      if (closed || signal?.aborted) return {
        pieces: [],
        code: 'INTERRUPTED'
      };
      const expected = String(text || '').trim();
      if (!expected) return {
        pieces: [],
        code: 'TEXT_REQUIRED'
      };
      const current = generation;
      if (primary?.synthesize) {
        let streamedPieces = false;
        try {
          const result = await primary.synthesize({
            text: expected,
            language,
            signal,
            onPiece: onPiece ? (piece) => {
              streamedPieces = true;
              onPiece(piece);
            } : undefined
          });
          if (closed || signal?.aborted || current !== generation) return {
            pieces: [],
            code: 'INTERRUPTED'
          };
          if (!result || !result.audio && !result.pieces?.length) throw new Error('EMPTY_AUDIO');
          if (!result?.spokenText || !voice.hasSpeechDrift(expected, result.spokenText, {
            ...drift,
            final: true
          })) {
            return {
              pieces: result?.pieces || [result],
              provider: primary.id || 'primary',
              fallback: false,
              streamed: Boolean(result.streamed)
            };
          }
          logger.warn?.('SPEECH_DRIFT');
          if (result.streamed) onReset?.();
        } catch (_error) {
          if (closed || signal?.aborted || current !== generation) return { pieces: [], code: 'INTERRUPTED' };
          if (streamedPieces) onReset?.();
          logger.warn?.('READER_PRIMARY_FAILED');
        }
      }
      try {
        const result = await fallback.synthesize(expected, {
          language
        });
        if (closed || signal?.aborted || current !== generation) return {
          pieces: [],
          code: 'INTERRUPTED'
        };
        if (onPiece) for (const piece of result.pieces || [result]) onPiece(piece);
        return {
          ...result,
          fallback: true,
          streamed: Boolean(onPiece)
        };
      } catch (_error) {
        if (closed || signal?.aborted || current !== generation) return { pieces: [], code: 'INTERRUPTED' };
        return {
          pieces: [],
          code: 'VOICE_UNAVAILABLE'
        };
      }
    },
    interrupt() {
      generation += 1;
      primary?.interrupt?.();
    },
    close() {
      closed = true;
      generation += 1;
      primary?.close?.();
    }
  };
}
function createGeminiLiveReader({
  adapter,
  websocketFactory,
  candidates,
  clock,
  voice: voiceName,
  providers = [],
  timeoutMs = 12000,
  instructions = '',
  logger = {}
}) {
  if (!clock) throw new TypeError('CLOCK_REQUIRED');
  const live = adapter || createGeminiLiveAdapter({
    websocketFactory,
    candidates,
    voice: voiceName,
    clock,
    logger
  });
  let currentLine = null;
  let rejectActive = null;
  let queue = Promise.resolve();
  const primary = {
    id: 'gemini-live',
    synthesize({
      text,
      signal,
      onPiece
    }) {
      const operation = queue.then(() => readTurn(text, signal, onPiece));
      queue = operation.catch(() => {});
      return operation;
    },
    interrupt() {
      rejectActive?.(new Error('INTERRUPTED'));
      currentLine?.close?.();
    },
    close() {
      rejectActive?.(new Error('INTERRUPTED'));
      currentLine?.close?.();
    }
  };
  async function readTurn(text, signal, onPiece) {
    const pieces = [];
    let transcription = '';
    let modelText = '';
    let settle;
    let reject;
    const completion = new Promise((resolve, fail) => {
      settle = resolve;
      reject = fail;
    });
    let timer;
    const abort = () => reject(new Error('INTERRUPTED'));
    try {
      currentLine = await live.connect({
        instructions,
        onEvent(event) {
          if (event.type === 'audio') {
            const piece = { audio: Buffer.from(event.data, 'base64'), mimeType: event.mimeType };
            pieces.push(piece);
            onPiece?.(piece);
          }
          if (event.type === 'said') transcription += event.text;
          if (event.type === 'text') modelText += event.text;
          if (event.type === 'turn') settle();
          if (event.type === 'error') reject(new Error(event.code));
        },
        onClose: reject
      });
      if (signal?.aborted) throw new Error('INTERRUPTED');
      rejectActive = reject;
      timer = clock.setTimeout(() => reject(new Error('READER_TIMEOUT')), timeoutMs);
      signal?.addEventListener?.('abort', abort, { once: true });
      currentLine.sendText(text);
      await completion;
      return {
        pieces,
        spokenText: transcription || modelText,
        streamed: Boolean(onPiece)
      };
    } finally {
      if (timer !== undefined) clock.clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      rejectActive = null;
      currentLine?.close?.();
      currentLine = null;
    }
  }
  return createLiveReader({
    primary,
    providers,
    logger
  });
}
module.exports = {
  createLiveReader,
  createGeminiLiveReader
};
