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
  createTranscribedRelay
} = require('./relay');
const {
  createTextThinker
} = require('./textModel');
const voice = require('@astratra/voice');
const {
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
/* Only what a person does (not the microphone running) shows that a call is alive. */
const HUMAN_MESSAGES = new Set(['text', 'confirm', 'cancel', 'mode']);
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
  instructions: instructionsOption,
  tools: toolsOption,
  wire = {},
  observe,
  onEnd,
  resumeWindowMs = 1800000,
  resumeTurns = 12,
  transcriptCompleteOnly = false,
  deferLatestExchange = false,
  idleMs = 60000,
  checkMs = 5000,
  maxCallMs = 1800000,
  shield = {},
  annotateToolResult,
  microphone = null,
  directAudio = null,
  directInterrupt = true
}) {
  if (!socket || !context?.userId || !clock) throw new TypeError('SESSION_DEPENDENCY_REQUIRED');
  const encode = wire.encode || encodeMessage;
  const decode = wire.decode || decodeMessage;
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
  let relay = null;
  let recorder = null;
  let timer = null;
  let warned = false;
  let conversationId = null;
  let history = [];
  let instructions = '';
  let tools = null;
  let gate = null;
  /* What the confidential path needs on this server: undefined until asked (only a confidential call asks). */
  let localSet;
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
  const emit = message => {
    if (socket.readyState !== 1) return;
    try {
      observe?.(message);
    } catch (_error) {/* Observing is optional. */}
    const raw = encode(message);
    if (raw) socket.send(raw);
  };
  const safeSend = message => {
    if (!ended) emit(message);
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
  const annotate = (name, result) => {
    try {
      const annotation = annotateToolResult?.(name, result);
      if (annotation != null) pendingAnnotations.push(annotation);
    } catch (_error) {/* Annotations are optional. */}
  };
  /* What the confidential path may run on: the whole local pipeline (transcribe, think, read), or only the transcription (the provider answers). */
  const localKind = () => {
    if (!localSet) return null;
    if (localSet.transcribe && (localSet.thinker || localSet.textModel) && (localSet.reader || localSet.readers)) return 'full';
    return localSet.transcriber ? 'relay' : null;
  };
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
    if (relay) {
      try {
        await relay.finish();
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
      emit({
        type: 'end',
        reason
      });
      socket.close(code);
    }
    /* Once the phone is let go: what the host keeps of the call (its logs) never delays the hang-up. */
    void Promise.resolve().then(() => onEnd?.({
      reason,
      code,
      startedAt,
      endedAt: clock.now(),
      turns: turns.slice(),
      conversationId
    })).catch(() => logger.warn?.('END_HOOK_FAILED'));
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
  /* How long a stretch of the provider's voice plays, for the echo guard: from its own mime type when it gives a rate. */
  const audioRate = event => Number(/rate=(\d+)/.exec(String(event.mimeType || ''))?.[1]) || directAudio?.outputRate || microphone?.outputRate || 24000;
  function onProviderEvent(event) {
    if (ended) return;
    if (event.type === 'heard') recordTurn('person', event.text);
    if (event.type === 'said' || event.type === 'text') recordTurn('assistant', event.text);
    if (event.type === 'tool') busy += 1;
    if (event.type === 'tool_done') busy = Math.max(0, busy - 1);
    if (event.type === 'audio' || event.type === 'ready' || event.type === 'turn' || event.type === 'tool_done') lastActivity = clock.now();
    if (event.type === 'turn') {
      turnOver = true;
      persist();
    }
    if (event.type === 'audio' && gate && event.data) gate.playbackSent(Buffer.byteLength(event.data, 'base64'), audioRate(event));
    if (event.type === 'interrupted') gate?.playbackInterrupted();
    if (event.type === 'error') {
      safeSend({
        type: 'error',
        reason: event.code || 'PROVIDER_ERROR'
      });
      return;
    }
    if (event.type !== 'handle' && event.type !== 'goAway' && event.type !== 'tools' && event.type !== 'toolCancel') safeSend(event);
  }
  /* The confidential path is asked for: what it needs is resolved once. Not there, the policy decides: the call goes on as normal (told), or ends. Null: the call was closed. */
  async function settle(requested) {
    if (requested !== 'confidential') return requested;
    if (localSet === undefined) {
      try {
        localSet = (typeof local === 'function' ? await local(context) : local) || null;
      } catch (_error) {
        localSet = null;
        logger.warn?.('LOCAL_LOAD_FAILED');
      }
    }
    if (localKind()) return 'confidential';
    const fallback = (policy || createConfidentialPolicy()).onLocalFailure({
      role: context.role,
      language: context.language,
      requestedMode: 'confidential',
      allowCloudFallback: context.allowCloudFallback
    });
    if (!fallback.cloudAudioAllowed) {
      await close('LOCAL_UNAVAILABLE', CLOSE.UNAVAILABLE);
      return null;
    }
    safeSend({
      type: 'fallback',
      reason: fallback.reason
    });
    return 'normal';
  }
  /* The person's sound goes to the provider as it is: from now on, and first the last sentence the local decoder could not read. */
  async function leaveRelay(reason, audio) {
    if (closing || !relay) return;
    relay = null;
    mode = 'normal';
    safeSend({
      type: 'fallback',
      reason
    });
    if (audio) line?.sendAudio(audio);
  }
  function startRelay(decisionSession) {
    relay = createTranscribedRelay({
      transcriber: localSet.transcriber,
      decision: decisionSession,
      send: safeSend,
      onHeard: () => {
        lastActivity = clock.now();
      },
      onSentence: text => {
        recordTurn('person', text);
        line?.sendText(text);
      },
      onFallback: leaveRelay,
      onUnavailable: () => close('LOCAL_UNAVAILABLE', CLOSE.UNAVAILABLE),
      minConfidence: localSet.minConfidence
    });
  }
  async function connectProvider(earlier) {
    if (!provider?.connect) {
      await close('PROVIDER_UNAVAILABLE', CLOSE.UNAVAILABLE);
      return false;
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
      /* The phone hung up while the line was opening: it is not left open on the provider's side. */
      if (closing) {
        line.close?.();
        line = null;
        return false;
      }
      return true;
    } catch (_error) {
      await close('PROVIDER_UNAVAILABLE', CLOSE.UNAVAILABLE);
      return false;
    }
  }
  /* Opens the line for a mode `settle` has confirmed. */
  async function openLine(nextMode, earlier) {
    line?.end?.();
    line?.close?.();
    line = null;
    relay = null;
    mode = nextMode;
    if (mode === 'confidential' && localKind() === 'full') {
      const service = localSet.readers ? voice.createPieceVoiceService({
        providers: localSet.readers
      }) : null;
      const reader = localSet.reader || {
        synthesize: ({
          text,
          language
        }) => service.synthesize(text, {
          language
        })
      };
      const textThinker = localSet.textModel ? createTextThinker({
        model: localSet.textModel,
        instructions,
        declarations: tools.declarations,
        tools,
        earlier,
        onTool: (name, state) => safeSend({ type: state === 'start' ? 'tool' : 'tool_done', name })
      }) : null;
      const thinker = localSet.thinker || (({
        text,
        onText,
        signal
      }) => textThinker.respond(text, {
        onText,
        signal
      }));
      if (textThinker && !localSet.thinker) thinker.undoLast = () => textThinker.undoLast();
      line = createConfidentialCall({
        ...localSet,
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
    if (!(await connectProvider(earlier))) return;
    if (mode === 'confidential') startRelay(voice.createConfidentialSession(policy || createConfidentialPolicy(), {
      role: context.role,
      language: context.language,
      requestedMode: 'confidential',
      allowCloudFallback: context.allowCloudFallback
    }));
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
      /* Even while the call is closing: the conversation made at the person's last words is still theirs to open. */
      onSaved: id => emit({
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
    mode = decision.mode === 'confidential' ? await settle(decision.mode) : decision.mode;
    if (mode === null || closing) return;
    const given = typeof toolsOption === 'function' ? await toolsOption(context) : toolsOption;
    if (given) tools = {
      ...given,
      call: async request => {
        const result = await given.call(request);
        annotate(request.name, result);
        return result;
      }
    };else tools = createCallTools({
      registry,
      context,
      confirmation,
      actions,
      shield,
      clock,
      send: safeSend,
      onResult: annotate,
      catalog
    });
    const prompt = typeof instructionsOption === 'function' ? await instructionsOption({
      context,
      mode,
      now: clock.now()
    }) : instructionsOption;
    instructions = typeof prompt === 'string' ? typeof shield.input === 'function' ? shield.input(prompt) : prompt : buildInstructions({
      persona,
      language: context.language,
      role: context.role,
      now: () => new Date(clock.now()).toISOString(),
      catalog,
      shield
    });
    /* The microphone's filters: a failure to make them never stands in the call's way. */
    try {
      const filtering = microphone || directAudio;
      const filters = typeof filtering === 'function' ? await filtering(context) : filtering;
      if (filters) gate = typeof filters.push === 'function' ? filters : voice.createMicrophoneGate({
        vad: filters.vad,
        echo: filters.echo,
        now: clock.now
      });
    } catch (_error) {
      logger.warn?.('MICROPHONE_FILTERS_FAILED');
    }
    await openLine(mode, history);
    if (ended || closing) return;
    timer = clock.setInterval(() => {
      void tick();
    }, checkMs);
    timer?.unref?.();
    for (const raw of pendingMessages.splice(0)) await receive(raw);
  }
  /* The microphone's sound, in order: through the filters, then to the local transcription or to the provider. */
  async function hear(data) {
    let audio = data;
    if (gate) {
      try {
        audio = await gate.push(data);
      } catch (_error) {
        audio = data;
      }
    }
    if (!audio || ended) return;
    if (relay) await relay.push(audio);else line?.sendAudio(audio);
  }
  async function receive(raw) {
    if (ended || closing) return;
    const message = decode(raw);
    if (!message) return;
    if (!line && message.type !== 'end') {
      if (pendingMessages.length < 200) pendingMessages.push(raw);
      return;
    }
    if (HUMAN_MESSAGES.has(message.type)) lastActivity = clock.now();
    if (message.type === 'end') return close('NORMAL');
    if (message.type === 'confirm' || message.type === 'cancel') {
      if (!tools?.confirmByClient) return;
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
      const settled = await settle(decision.mode);
      if (settled === null) return;
      if (settled !== mode) {
        persist();
        /* Only the transcription is local: the provider's line stays open, the sound is just sent to the other place. */
        if (localKind() === 'relay' && line && !line.receive) {
          mode = settled;
          relay = null;
          if (mode === 'confidential') startRelay(voice.createConfidentialSession(policy || createConfidentialPolicy(), {
            role: context.role,
            language: context.language,
            requestedMode: 'confidential',
            allowCloudFallback: context.allowCloudFallback
          }));
        } else await openLine(settled, [...history, ...turns]);
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
    if (mode === 'confidential' && line?.receive) return line.receive(message);
    if (message.type === 'audio' && !muted && typeof message.data === 'string') {
      if (!gate && !relay && localKind() !== 'relay') line?.sendAudio(message.data);else {
        audioQueue = audioQueue.then(() => hear(message.data)).catch(() => {});
        await audioQueue;
      }
    }
    if (message.type === 'text' && typeof message.text === 'string' && message.text.length <= 2000) {
      recordTurn('person', message.text);
      turnOver = true;
      line?.sendText(message.text);
    }
    if (message.type === 'image' && typeof message.data === 'string' && message.data.length <= 256 * 1024) {
      if (line?.sendImage?.(message.data) !== false) lastActivity = clock.now();
    }
    if (message.type === 'interrupt') {
      if (relay) {
        /* The text turn that follows the person's words is what stops the provider: the phone is told, and the guard stops waiting for an echo. */
        gate?.playbackInterrupted();
        safeSend({
          type: 'interrupted'
        });
      } else if (directInterrupt) line?.interrupt?.();
    }
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
    },
    get history() {
      return history.slice();
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
  conversationIdPattern = /^[\w:.-]{1,120}$/,
  encode = encodeMessage
}) {
  if (!httpServer?.on || !websocketServer?.handleUpgrade ||
      typeof authenticate !== 'function' || typeof createSession !== 'function') {
    throw new TypeError('SERVER_DEPENDENCY_REQUIRED');
  }
  const calls = new Map();
  /* What the server says by itself, in the client's own words (or not at all, if the client never knew it). */
  const tell = (client, message) => {
    const raw = encode(message);
    if (raw) client.send(raw);
  };
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
          if (verdict?.reason && client.readyState === 1) tell(client, { type: 'error', reason: verdict.reason });
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
        if (client.readyState === 1) tell(client, { type: 'error', reason: 'BUSY' });
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
        /* What the session had already opened (a line to the provider) is closed with it. */
        try {
          await session?.close?.('SESSION_START_FAILED', CLOSE.UNAVAILABLE);
        } catch (_error) {/* The client is closed below all the same. */}
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
      /* 1001, "going away": a server that stops is not a call that ended well. */
      for (const session of calls.values()) void session.close('SERVER_CLOSED', 1001);
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
