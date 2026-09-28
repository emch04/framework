'use strict';

const {
  createConfidentialPolicy
} = require('@astratra/voice');
const {
  decodeMessage,
  encodeMessage
} = require('./protocol');
const {
  resumeConversation,
  createTranscriptRecorder,
  consolidateAfterCall
} = require('./continuity');
const {
  createSpokenConfirmation,
  createCallTools,
  buildInstructions
} = require('./tools');
const {
  createConfidentialCall
} = require('./confidential');
const {
  createTextThinker
} = require('./textModel');
const voice = require('@astratra/voice');
const {
  base64ToBytes,
  pcm16ToFloat,
  floatToPcm16,
  bytesToBase64
} = require('./protocol');
const CLOSE = Object.freeze({
  AUTH: 4401,
  DENIED: 4403,
  REPLACED: 4409,
  BUSY: 4429,
  UNAVAILABLE: 4503,
  NORMAL: 1000
});
function createLiveSession({
  socket,
  context,
  provider,
  local,
  policy,
  registry,
  actions,
  quota,
  lease,
  transcripts,
  memory,
  clock,
  logger = {},
  catalog = {},
  persona = '',
  resumeWindowMs = 1800000,
  resumeTurns = 12,
  transcriptCompleteOnly = false,
  deferLatestExchange = false,
  idleMs = 60000,
  checkMs = 5000,
  maxCallMs = 1800000,
  shield = {},
  annotateToolResult,
  directAudio = null
}) {
  if (!socket || !context?.userId || !clock) throw new TypeError('SESSION_DEPENDENCY_REQUIRED');
  const startedAt = clock.now();
  const callId = context.callId || `${context.userId}:${startedAt}`;
  let lastDebitAt = startedAt;
  let chargedMs = 0;
  let lastActivity = startedAt;
  let busy = 0;
  let ended = false;
  let closing = false;
  let muted = false;
  let mode = null;
  let line = null;
  let recorder = null;
  let timer = null;
  let warned = false;
  let conversationId = null;
  let history = [];
  let instructions = '';
  let gate = null;
  let echo = null;
  let audioQueue = Promise.resolve();
  let turnOver = false;
  const pendingMessages = [];
  const turns = [];
  let pendingAnnotations = [];
  const confirmation = createSpokenConfirmation({
    now: clock.now,
    affirmative: catalog.affirmative,
    negative: catalog.negative
  });
  const safeSend = message => {
    if (!ended && socket.readyState === 1) socket.send(encodeMessage(message));
  };
  const recordTurn = (who, text) => {
    if (!text) return;
    const entry = {
      who,
      text: String(text)
    };
    if (who === 'assistant' && pendingAnnotations.length) {
      entry.annotations = pendingAnnotations;
      pendingAnnotations = [];
    }
    const prior = turns.at(-1);
    if (prior?.who === who && !turnOver) {
      prior.text += entry.text;
      if (entry.annotations) prior.annotations = [...(prior.annotations || []), ...entry.annotations];
    } else turns.push(entry);
    turnOver = false;
    confirmation.heard(entry);
    lastActivity = clock.now();
  };
  const persist = () => {
    void recorder?.record(turns).catch(error => logger.warn?.('TRANSCRIPT_FAILED', {
      code: error?.code
    }));
  };
  const tools = createCallTools({
    registry,
    context,
    confirmation,
    actions,
    shield,
    clock,
    send: safeSend,
    onResult: (name, result) => {
      const annotation = annotateToolResult?.(name, result);
      if (annotation != null) pendingAnnotations.push(annotation);
    },
    catalog
  });
  async function close(reason = 'NORMAL', code = CLOSE.NORMAL) {
    if (ended || closing) return;
    closing = true;
    if (reason === 'NORMAL' && line?.flush) {
      try {
        await line.flush();
      } catch (_error) {
        logger.warn?.('FINAL_AUDIO_FLUSH_FAILED');
      }
    }
    ended = true;
    if (timer) clock.clearInterval(timer);
    line?.end?.();
    line?.close?.();
    try {
      await recorder?.record(turns, { final: true });
    } catch (error) {
      logger.warn?.('TRANSCRIPT_FAILED', {
        code: error?.code
      });
    }
    try {
      conversationId = (await recorder?.kept()) || conversationId;
    } catch (_error) {/* Persistence is optional. */}
    try {
      await quota?.charge(context, startedAt, chargedMs);
    } catch (_error) {
      logger.warn?.('QUOTA_CHARGE_FAILED');
    }
    try {
      await lease?.release(context.userId, callId);
    } catch (_error) {
      logger.warn?.('LEASE_RELEASE_FAILED');
    }
    void consolidateAfterCall(memory, context.memoryWhere || {
      userId: context.userId
    }, turns, conversationId, logger);
    if (socket.readyState === 1) {
      socket.send(encodeMessage({
        type: 'end',
        reason
      }));
      socket.close(code);
    }
  }
  async function tick() {
    if (ended || closing) return;
    try {
      if (lease && !(await lease.isOwner(context.userId, callId))) {
        await close('REPLACED', CLOSE.REPLACED);
        return;
      }
    } catch (_error) {
      logger.warn?.('LEASE_CHECK_FAILED');
    }
    if (clock.now() - startedAt >= maxCallMs) {
      await close('CALL_LIMIT');
      return;
    }
    if (!busy && !line?.busy && clock.now() - lastActivity >= idleMs) {
      safeSend({
        type: 'idle'
      });
      await close('IDLE');
      return;
    }
    try {
      if (quota?.debit) {
        const now = clock.now();
        chargedMs += await quota.debit(context, now - lastDebitAt);
        lastDebitAt = now;
      }
      const result = await quota?.check(context, startedAt, chargedMs);
      if (result?.code === 'QUOTA_EXHAUSTED' || result?.code === 'GROUP_LIMIT') await close(result.code);else if (!warned && result?.code === 'QUOTA_WARNING') {
        warned = true;
        safeSend({
          type: 'quota',
          code: result.code,
          remainingMs: result.remainingMs
        });
      }
    } catch (_error) {
      logger.warn?.('QUOTA_CHECK_FAILED');
    }
  }
  function onProviderEvent(event) {
    if (ended) return;
    if (event.type === 'heard') recordTurn('person', event.text);
    if (event.type === 'said' || event.type === 'text') recordTurn('assistant', event.text);
    if (event.type === 'tool') busy += 1;
    if (event.type === 'tool_done') busy = Math.max(0, busy - 1);
    if (event.type === 'audio' || event.type === 'ready' || event.type === 'turn') lastActivity = clock.now();
    if (event.type === 'turn') {
      turnOver = true;
      persist();
    }
    if (event.type === 'audio' && echo && event.data) echo.playbackSent(base64ToBytes(event.data).length, directAudio?.outputRate || 24000);
    if (event.type === 'interrupted') echo?.playbackInterrupted();
    if (event.type === 'error') {
      safeSend({
        type: 'error',
        reason: event.code || 'PROVIDER_ERROR'
      });
      return;
    }
    if (event.type !== 'handle' && event.type !== 'goAway' && event.type !== 'tools' && event.type !== 'toolCancel') safeSend(event);
  }
  async function openLine(nextMode, earlier) {
    line?.end?.();
    line?.close?.();
    line = null;
    mode = nextMode;
    if (mode === 'confidential' && local?.transcribe && (local?.thinker || local?.textModel) && (local?.reader || local?.readers)) {
      const service = local.readers ? voice.createPieceVoiceService({
        providers: local.readers
      }) : null;
      const reader = local.reader || {
        synthesize: ({
          text,
          language
        }) => service.synthesize(text, {
          language
        })
      };
      const textThinker = local.textModel ? createTextThinker({
        model: local.textModel,
        instructions,
        declarations: tools.declarations,
        tools,
        earlier,
        onTool: (name, state) => safeSend({ type: state === 'start' ? 'tool' : 'tool_done', name })
      }) : null;
      const thinker = local.thinker || (({
        text,
        onText,
        signal
      }) => textThinker.respond(text, {
        onText,
        signal
      }));
      if (textThinker && !local.thinker) thinker.undoLast = () => textThinker.undoLast();
      line = createConfidentialCall({
        ...local,
        thinker,
        reader,
        policy,
        earlier,
        session: {
          role: context.role,
          language: context.language,
          requestedMode: 'confidential',
          allowCloudFallback: context.allowCloudFallback
        },
        shield,
        tools,
        send: safeSend,
        onTurn: turn => {
          recordTurn(turn.who, turn.text);
          if (turn.who === 'assistant') {
            turnOver = true;
            persist();
          }
        },
        clock,
        repeatText: catalog.repeat?.[context.language],
        onFallback: async (reason, audio) => {
          if (closing) return;
          safeSend({
            type: 'fallback',
            reason
          });
          await openLine('normal', [...history, ...turns]);
          if (audio && line?.sendAudio) {
            const bytes = floatToPcm16(audio);
            for (let at = 0; at < bytes.length; at += 32000) {
              line.sendAudio(bytesToBase64(bytes.subarray(at, at + 32000)));
            }
            line.sendAudio(bytesToBase64(new Uint8Array(32000)));
          }
        }
      });
      safeSend({
        type: 'ready',
        mode
      });
      return;
    }
    if (mode === 'confidential') {
      const fallback = (policy || createConfidentialPolicy()).onLocalFailure({
        role: context.role,
        language: context.language,
        requestedMode: 'confidential',
        allowCloudFallback: context.allowCloudFallback
      });
      if (!fallback.cloudAudioAllowed) {
        await close('LOCAL_UNAVAILABLE', CLOSE.UNAVAILABLE);
        return;
      }
      mode = 'normal';
      safeSend({
        type: 'fallback',
        reason: fallback.reason
      });
    }
    if (!provider?.connect) {
      await close('PROVIDER_UNAVAILABLE', CLOSE.UNAVAILABLE);
      return;
    }
    const protectedEarlier = earlier.map(turn => ({
      ...turn,
      text: typeof shield.history === 'function' ? shield.history(turn.text) : turn.text
    }));
    try {
      line = await provider.connect({
        instructions,
        tools,
        earlier: protectedEarlier,
        getHistory: () => [...history, ...turns].map(turn => ({
          ...turn,
          text: typeof shield.history === 'function' ? shield.history(turn.text) : turn.text
        })),
        onEvent: onProviderEvent,
        onClose: code => void close(code, CLOSE.UNAVAILABLE)
      });
    } catch (_error) {
      await close('PROVIDER_UNAVAILABLE', CLOSE.UNAVAILABLE);
    }
  }
  async function start() {
    if (quota) {
      try {
        const initial = await quota.check(context, startedAt);
        if (initial.code === 'QUOTA_EXHAUSTED' || initial.code === 'GROUP_LIMIT') {
          await close(initial.code);
          return;
        }
      } catch (_error) {
        logger.warn?.('QUOTA_CHECK_FAILED');
      }
    }
    try {
      await lease?.acquire(context.userId, callId);
    } catch (_error) {
      logger.warn?.('LEASE_ACQUIRE_FAILED');
    }
    const resumed = await resumeConversation({
      store: transcripts,
      userId: context.userId,
      requestedId: context.conversationId,
      now: clock.now,
      windowMs: resumeWindowMs,
      maxTurns: resumeTurns
    });
    conversationId = resumed?.id || null;
    history = resumed?.turns || [];
    recorder = createTranscriptRecorder({
      store: transcripts,
      userId: context.userId,
      conversationId,
      now: clock.now,
      completeOnly: transcriptCompleteOnly,
      deferLatestExchange,
      onSaved: id => safeSend({
        type: 'saved',
        conversationId: id
      })
    });
    if (conversationId) safeSend({
      type: 'saved',
      conversationId
    });
    const decision = (policy || createConfidentialPolicy()).decide({
      role: context.role,
      language: context.language,
      requestedMode: context.mode
    });
    mode = decision.mode;
    instructions = buildInstructions({
      persona,
      language: context.language,
      role: context.role,
      now: () => new Date(clock.now()).toISOString(),
      catalog,
      shield
    });
    if (directAudio) {
      gate = voice.createVadSpeechGate(directAudio.vad || {});
      echo = voice.createEchoGuard({
        now: clock.now,
        ...(directAudio.echo || {})
      });
    }
    await openLine(mode, history);
    if (ended) return;
    timer = clock.setInterval(() => {
      void tick();
    }, checkMs);
    timer?.unref?.();
    for (const raw of pendingMessages.splice(0)) await receive(raw);
  }
  async function receive(raw) {
    if (ended || closing) return;
    const message = decodeMessage(raw);
    if (!message) return;
    if (!line && message.type !== 'end') {
      if (pendingMessages.length < 200) pendingMessages.push(raw);
      return;
    }
    lastActivity = clock.now();
    if (message.type === 'end') return close('NORMAL');
    if (message.type === 'confirm' || message.type === 'cancel') {
      const result = await (message.type === 'confirm' ? tools.confirmByClient(message.actionId) : tools.cancelByClient(message.actionId));
      if (result.code && result.code !== 'ACTION_DONE' && result.code !== 'ACTION_CANCELLED') safeSend({
        type: 'error',
        reason: result.code
      });
      return;
    }
    if (message.type === 'mode') {
      const decision = (policy || createConfidentialPolicy()).decide({
        role: context.role,
        language: context.language,
        requestedMode: message.mode
      });
      if (decision.mode !== mode) {
        persist();
        await openLine(decision.mode, [...history, ...turns]);
      }
      safeSend({
        type: 'mode',
        mode,
        reason: decision.reason
      });
      return;
    }
    if (message.type === 'mute') {
      muted = true;
      line?.mute?.();
    }
    if (message.type === 'unmute') muted = false;
    if (mode === 'confidential') return line?.receive(message);
    if (message.type === 'audio' && !muted && typeof message.data === 'string') {
      if (!gate && !echo) line?.sendAudio(message.data);else {
        audioQueue = audioQueue.then(async () => {
          const raw = pcm16ToFloat(base64ToBytes(message.data));
          const filtered = await gate.push(raw);
          const accepted = await echo.filter(filtered);
          if (accepted?.length) line?.sendAudio(bytesToBase64(floatToPcm16(accepted)));
        }).catch(() => line?.sendAudio(message.data));
        await audioQueue;
      }
    }
    if (message.type === 'text' && typeof message.text === 'string' && message.text.length <= 2000) {
      recordTurn('person', message.text);
      turnOver = true;
      line?.sendText(message.text);
    }
    if (message.type === 'image' && typeof message.data === 'string' && message.data.length <= 256 * 1024) line?.sendImage?.(message.data);
    if (message.type === 'interrupt') line?.interrupt?.();
  }
  return {
    start,
    receive,
    close,
    tick,
    get mode() {
      return mode;
    },
    get ended() {
      return ended;
    },
    get turns() {
      return turns.slice();
    }
  };
}
function attachLive({
  httpServer,
  websocketServer,
  authenticate,
  authorize,
  createSession,
  path = '/live',
  maxCalls = 8,
  logger = {},
  languages = [],
  modes = ['normal', 'confidential'],
  conversationIdPattern = /^[\w:.-]{1,120}$/
}) {
  if (!httpServer?.on || !websocketServer?.handleUpgrade ||
      typeof authenticate !== 'function' || typeof createSession !== 'function') {
    throw new TypeError('SERVER_DEPENDENCY_REQUIRED');
  }
  const calls = new Map();
  async function upgrade(request, socket, head) {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch (_error) {
      return;
    }
    if (url.pathname !== path) return;
    let context;
    try {
      context = await authenticate(request);
    } catch (_error) {
      context = null;
    }
    websocketServer.handleUpgrade(request, socket, head, async client => {
      if (!context?.userId) {
        client.close(CLOSE.AUTH);
        return;
      }
      if (authorize) {
        let verdict;
        try { verdict = await authorize(request, context); }
        catch (_error) { verdict = { allowed: false, reason: 'DENIED' }; }
        if (verdict === false || verdict?.allowed === false) {
          if (verdict?.reason && client.readyState === 1) client.send(encodeMessage({ type: 'error', reason: verdict.reason }));
          client.close(verdict?.code || CLOSE.DENIED);
          return;
        }
      }
      const userId = String(context.userId);
      if (calls.has(userId)) {
        await calls.get(userId).close('REPLACED', CLOSE.REPLACED);
        calls.delete(userId);
      }
      if (calls.size >= maxCalls) {
        client.close(CLOSE.BUSY);
        return;
      }
      let session;
      try {
        const language = url.searchParams.get('lang');
        const conversationId = url.searchParams.get('conversation');
        const requestedMode = url.searchParams.get('mode');
        session = createSession({
          socket: client,
          context: {
            ...context,
            userId,
            language: languages.includes(language) ? language : context.language,
            conversationId: conversationId && conversationIdPattern.test(conversationId) ? conversationId : context.conversationId,
            mode: modes.includes(requestedMode) ? requestedMode : context.mode
          }
        });
        calls.set(userId, session);
        client.on('message', raw => {
          void session.receive(raw).catch(error => logger.warn?.('SESSION_RECEIVE_FAILED', { code: error?.code }));
        });
        client.on('close', () => {
          void session.close('NORMAL').catch(error => logger.warn?.('SESSION_CLOSE_FAILED', { code: error?.code }));
          if (calls.get(userId) === session) calls.delete(userId);
        });
        await session.start();
      } catch (error) {
        logger.warn?.('SESSION_START_FAILED', {
          code: error?.code
        });
        client.close(CLOSE.UNAVAILABLE);
        if (calls.get(userId) === session) calls.delete(userId);
      }
    });
  }
  httpServer.on('upgrade', upgrade);
  return {
    get size() {
      return calls.size;
    },
    close() {
      httpServer.off?.('upgrade', upgrade);
      for (const session of calls.values()) void session.close('SERVER_CLOSED');
      calls.clear();
      websocketServer.close?.();
    }
  };
}
module.exports = {
  CLOSE,
  createLiveSession,
  attachLive
};
