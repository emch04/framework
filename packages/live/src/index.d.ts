export type Awaitable<T> = T | Promise<T>;
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}
export interface CallContext {
  userId: string;
  role: string;
  plan?: string;
  groupId?: string;
  callId?: string;
  language?: string;
  mode?: string;
  conversationId?: string | null;
  allowCloudFallback?: boolean;
  memoryWhere?: unknown;
}
export interface CallMessage {
  type: string;
  [key: string]: unknown;
}
export interface Socket {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}
export interface ProviderLine {
  sendAudio(data: string, mimeType?: string): void;
  sendText(text: string): void;
  sendImage?(data: string): void;
  mute?(): void;
  interrupt?(): void;
  close(): void;
  readonly model?: string | null;
}
export interface ProviderAdapter {
  connect(options: {
    instructions: string;
    tools?: unknown;
    earlier?: unknown[];
    getHistory?: () => unknown[];
    mode?: string;
    onEvent?: (event: CallMessage) => void;
    onClose?: (reason: string) => void;
  }): Promise<ProviderLine>;
}
export declare const PHASES: Set<string>;
export declare function encodeMessage(message: CallMessage): string;
export declare function decodeMessage(raw: unknown, options?: {
  maxBytes?: number;
}): CallMessage | null;
export declare function nextCallState(state: {
  phase: string;
  reason: string | null;
  muted: boolean;
}, event: CallMessage): {
  phase: string;
  reason: string | null;
  muted: boolean;
};
export declare function floatToPcm16(samples: Float32Array): Uint8Array;
export declare function pcm16ToFloat(bytes: Uint8Array): Float32Array;
export declare function bytesToBase64(bytes: Uint8Array): string;
export declare function base64ToBytes(value: string): Uint8Array;
export declare function resample(samples: Float32Array, from: number, to: number): Float32Array;
export declare function audioLevel(samples: Float32Array): number;
export declare function encodeMicroChunk(samples: Float32Array, inputRate: number, outputRate?: number): string;
export declare function decodeVoiceChunk(data: string): Float32Array;
export declare function shouldInterrupt(input: {
  level: number;
  playing: boolean;
  threshold?: number;
  mode?: string;
}): boolean;
export declare function createAudioPacer(options: {
  sampleRate?: number;
  framesPerSecond?: number;
  maxQueuedMs?: number;
  send(data: string): void;
  clock?: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
}): {
  push(samples: Float32Array, inputRate?: number): number;
  clear(): void;
  stop(): void;
  readonly queued: number;
};
export declare function serverReason(reason: unknown): string | null;
export declare function closeOutcome(code: number, options?: {
  reason?: string | null;
  refreshed?: boolean;
}): {
  kind: string;
  code?: string;
};
export declare function nextSubtitle(state: {
  text: string;
  fresh: boolean;
}, event: CallMessage): {
  text: string;
  fresh: boolean;
};
export declare function subtitleTail(text: string, max?: number): string;
export declare function nextConsent(state: {
  actionId: string;
  readback: string;
} | null, event: CallMessage): {
  actionId: string;
  readback: string;
} | null;
export declare function nextTranscript(turns: Array<{
  role: string;
  text: string;
}>, event: CallMessage): Array<{
  role: string;
  text: string;
}>;
export declare function cleanTranscript(turns: Array<{
  role: string;
  text: string;
}>): Array<{
  role: string;
  text: string;
}>;
export declare function nextHeard(state: {
  text: string;
  fresh: boolean;
  uncertain: boolean;
}, event: CallMessage): {
  text: string;
  fresh: boolean;
  uncertain: boolean;
};
export declare function callUrl(baseUrl: string, options?: {
  path?: string;
  language?: string;
  conversationId?: string | null;
  mode?: string | null;
}): string;
export declare function languageCode(value: unknown, supported?: string[], fallback?: string): string;
export declare function resumeConversation(options: {
  store?: {
    get(id: string, userId: string): Awaitable<unknown>;
    latest(userId: string): Awaitable<unknown>;
  };
  userId: string;
  requestedId?: string | null;
  now(): number;
  windowMs?: number;
  maxTurns?: number;
}): Promise<{
  id: string;
  turns: unknown[];
} | null>;
export declare function createTranscriptRecorder(options: {
  store?: unknown;
  userId: string;
  conversationId?: string | null;
  now(): number;
  onSaved?(id: string): void;
  maxChars?: number;
  completeOnly?: boolean;
  deferLatestExchange?: boolean;
}): {
  record(turns: Array<{
    who: string;
    text: string;
    annotations?: unknown[];
  }>, options?: {
    final?: boolean;
  }): Promise<void>;
  kept(): Promise<string | null>;
};
export declare function consolidateAfterCall(memory: {
  consolidate(where: unknown, input: unknown): Awaitable<unknown>;
} | null, where: unknown, transcript: unknown[], id: string | null, logger?: unknown): Promise<unknown>;
export declare function createMemoryMinuteStore(options: {
  now(): number;
}): {
  usedMs(userId: string, plan?: string, role?: string): Promise<number>;
  addMs(userId: string, plan: string | undefined, role: string | undefined, ms: number): Promise<void>;
  usedGroupMs(groupId: string, plan?: string): Promise<number>;
  addGroupMs(groupId: string, plan: string | undefined, ms: number): Promise<void>;
};
export declare function createMinuteQuota(options: {
  store?: {
    usedMs?(userId: string, plan?: string, role?: string): Awaitable<number>;
    addMs?(userId: string, plan: string | undefined, role: string | undefined, ms: number): Awaitable<unknown>;
    usedGroupMs?(groupId: string, plan?: string): Awaitable<number>;
    addGroupMs?(groupId: string, plan: string | undefined, ms: number): Awaitable<unknown>;
  };
  limits?: Record<string, unknown>;
  now(): number;
  warningBeforeMs?: number;
  maxCallMs?: number;
  countGroup?(ctx: CallContext): boolean;
}): {
  check(ctx: CallContext, startedAt: number, chargedMs?: number): Promise<{
    remainingMs: number;
    code: string;
    reason: string;
  }>;
  debit(ctx: CallContext, ms: number): Promise<number>;
  charge(ctx: CallContext, startedAt: number, chargedMs?: number): Promise<number>;
  limitFor(ctx: CallContext): number;
  groupLimitFor(ctx: CallContext): number;
};
export declare function createDailyCounter(options: {
  store?: {
    get(key: string): Awaitable<number>;
    add(key: string, amount: number, ttlMs: number): Awaitable<unknown>;
  };
  now(): number;
}): {
  used(id: string): Promise<number>;
  add(id: string, amount?: number): Promise<number>;
};
export declare function createCallLease(options: {
  store: {
    get(userId: string): Awaitable<string | null>;
    set(userId: string, callId: string, ttlMs: number): Awaitable<unknown>;
    delete(userId: string): Awaitable<unknown>;
  };
  ttlMs?: number;
}): {
  acquire(userId: string, callId: string): Promise<void>;
  isOwner(userId: string, callId: string): Promise<boolean>;
  release(userId: string, callId: string): Promise<void>;
};
export declare function normalizeSpeech(value: unknown): string;
export declare function createSpokenConfirmation(options: {
  now(): number;
  timeoutMs?: number;
  affirmative?: Record<string, string[]>;
  negative?: Record<string, string[]>;
}): {
  propose(id: string): void;
  heard(turn: {
    who: string;
    text: string;
  }): void;
  verify(id: string, language: string): string;
  clear(id: string): void;
  readonly pendingId: string | null;
};
export declare function toolDeclarations(registry: unknown, role: string, catalog?: Record<string, string>): unknown[];
export declare function createCallTools(options: {
  registry?: unknown;
  context: CallContext;
  confirmation: ReturnType<typeof createSpokenConfirmation>;
  actions?: unknown;
  shield?: unknown;
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
  timeoutMs?: number;
  maxResultChars?: number;
  send?(message: CallMessage): void;
  onResult?(name: string, result: unknown): void;
  catalog?: Record<string, string>;
}): {
  declarations: unknown[];
  call(request: {
    name: string;
    args?: Record<string, unknown>;
  }): Promise<unknown>;
  confirmByClient(actionId: string): Promise<unknown>;
  cancelByClient(actionId: string): Promise<unknown>;
};
export declare function buildInstructions(options: {
  persona?: string;
  language?: string;
  role?: string;
  now?(): string;
  catalog?: Record<string, unknown>;
  shield?: unknown;
}): string;
export declare function createLiveShield(options?: {
  omitKey?(key: string, path: string[], value: unknown): boolean;
  redactText?(text: string): string;
  maskText?(text: string): string;
  unmaskText?(text: string): string;
  maxDepth?: number;
}): {
  input(text: string): string;
  output(text: string): string;
  args(value: unknown): unknown;
  result(value: unknown): unknown;
  external(value: unknown): unknown;
  history(value: unknown): unknown;
};
export declare function geminiSetup(options: {
  model: string;
  voice?: string;
  instructions: string;
  declarations?: unknown[];
  handle?: string | null;
  mode?: string;
}): unknown;
export declare function geminiEvents(message: Record<string, unknown>): CallMessage[];
export interface LiveCandidate {
  model: string;
  key: string;
}
export interface HandoverTurn {
  who: string;
  text: string;
  [key: string]: unknown;
}
export declare function createGeminiLiveAdapter(options: {
  websocketFactory(url: string): unknown;
  /** Ordered {model, key} pairs, or a function giving them: asked again at every change of line (keys that are reloaded while the server runs). */
  candidates: LiveCandidate[] | (() => LiveCandidate[]);
  endpoint?: string;
  voice?: string;
  clock: Clock;
  openTimeoutMs?: number;
  cooldownMs?: number;
  maxHeld?: number;
  maxImageBytes?: number;
  /** The most characters of a base64 image (default: what maxImageBytes gives). */
  maxImageChars?: number;
  imageEveryMs?: number;
  /** Whether a session was refused or cut for its key or its quota: the key rests and the next one takes over. */
  gaveOut?(closed: { code?: number; reason?: string }): boolean;
  /** What a session that knows nothing is told: `resume` at the first line of a call that goes on with a conversation, `switch` on another line of the same call. */
  handover?(input: { kind: 'resume' | 'switch'; turns: HandoverTurn[] }): { text: string; turnComplete?: boolean };
  /** The response given to the provider when a tool throws (default: { result: { code: 'TOOL_FAILED' } }). */
  toolError?(error: unknown): Record<string, unknown>;
  logger?: unknown;
}): ProviderAdapter;
export declare function parseSse(stream: AsyncIterable<Uint8Array>): AsyncIterable<unknown>;
export declare function createGeminiTextModel(options: {
  fetch(url: string, options: unknown): Promise<unknown>;
  candidates: Array<{
    model: string;
    key: string;
  }>;
  endpoint?: string;
  clock: Clock;
  timeoutMs?: number;
  cooldownMs?: number;
  generationConfig?: Record<string, unknown>;
  logger?: unknown;
}): {
  generate(input: unknown): Promise<{
    parts: unknown[];
    interrupted: boolean;
  }>;
};
export declare function createTextThinker(options: {
  model: {
    generate(input: unknown): Promise<unknown>;
  };
  instructions: string;
  declarations?: unknown[];
  tools: {
    call(input: unknown): Promise<unknown>;
  };
  earlier?: unknown[];
  maxTurns?: number;
  maxHistory?: number;
  onTool?(name: string, state: string): void;
}): {
  respond(question: string, options?: {
    onText?(text: string): void;
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    interrupted: boolean;
    limitReached?: boolean;
  }>;
  undoLast(): void;
  readonly history: unknown[];
};
export declare function createLiveReader(options?: {
  primary?: {
    id?: string;
    synthesize(input: unknown): Promise<unknown>;
    interrupt?(): void;
    close?(): void;
  };
  providers?: Array<{
    id?: string;
    synthesize(input: unknown): Promise<unknown>;
  }>;
  maxConcurrent?: number;
  drift?: Record<string, unknown>;
  logger?: unknown;
}): {
  synthesize(input: {
    text: string;
    language?: string;
    signal?: AbortSignal;
    onPiece?(piece: unknown): void;
    onReset?(): void;
  }): Promise<{
    pieces: unknown[];
    code?: string;
    provider?: string;
    fallback?: boolean;
    streamed?: boolean;
  }>;
  interrupt(): void;
  close(): void;
};
export declare function createGeminiLiveReader(options: {
  adapter?: ProviderAdapter;
  websocketFactory?: (url: string) => unknown;
  candidates?: Array<{
    model: string;
    key: string;
  }>;
  clock: Clock;
  voice?: string;
  providers?: Array<{
    id?: string;
    synthesize(input: unknown): Promise<unknown>;
  }>;
  timeoutMs?: number;
  instructions?: string;
  logger?: unknown;
}): ReturnType<typeof createLiveReader>;
export declare function createConfidentialCall(options: {
  voiceOptions?: unknown;
  transcribe(samples: Float32Array): Awaitable<unknown>;
  thinker(input: unknown): Awaitable<unknown>;
  reader: {
    synthesize(input: unknown): Awaitable<unknown>;
    interrupt?(): void;
    close?(): void;
  };
  policy?: unknown;
  session: CallContext;
  shield?: unknown;
  tools?: unknown;
  send(message: CallMessage): void;
  onFallback?(reason: string, audio?: Float32Array): void;
  onTurn?(turn: {
    who: string;
    text: string;
  }): void;
  clock: Clock;
  repeatText?: string | null;
  earlier?: Array<{
    who?: string;
    role?: string;
    text: string;
  }>;
}): {
  receive(message: CallMessage): Promise<void> | void;
  end(): void;
  flush(): Promise<void>;
  snapshot(): unknown;
  readonly history: unknown[];
  readonly busy: boolean;
};
export declare const CLOSE: Readonly<{
  AUTH: number;
  DENIED: number;
  REPLACED: number;
  BUSY: number;
  UNAVAILABLE: number;
  NORMAL: number;
}>;
export interface LiveTools {
  declarations: unknown[];
  call(request: { id?: string; name: string; args?: Record<string, unknown> }): Promise<unknown>;
  confirmByClient?(actionId: string): Promise<{ code?: string }>;
  cancelByClient?(actionId: string): Promise<{ code?: string }>;
}
export interface MicrophoneGate {
  push(base64: string): Promise<string>;
  playbackSent(bytes: number, sampleRate: number): void;
  playbackInterrupted(): void;
}
export interface MicrophoneFilters {
  vad?: unknown;
  echo?: unknown;
  outputRate?: number;
}
export interface LocalTranscriber {
  push(base64: string): Promise<Array<{ text: string; confidence?: number | null; audio?: string }>>;
  finish(): Promise<Array<{ text: string; confidence?: number | null; audio?: string }>>;
}
export interface LiveWire {
  /** What goes to the client: a string, or null for a message that client never knew. */
  encode?(message: CallMessage): string | null;
  /** What the client sent, as a message, or null. */
  decode?(raw: unknown): CallMessage | null;
}
export declare function createTranscribedRelay(options: {
  transcriber: LocalTranscriber;
  decision: unknown;
  send(message: CallMessage): void;
  onHeard(text: string): void;
  onSentence(text: string): void;
  onFallback(reason: string, audio?: string): Awaitable<void>;
  onUnavailable(): Awaitable<void>;
  minConfidence?: number;
}): {
  push(base64: string): Promise<void>;
  finish(): Promise<void>;
};
export declare function createLiveSession(options: {
  socket: Socket;
  context: CallContext;
  provider?: ProviderAdapter;
  /**
   * What the confidential path runs on, here: `{ transcribe, thinker | textModel, reader | readers }` (the whole
   * local pipeline), or `{ transcriber, minConfidence? }` (only the transcription is local: the provider answers,
   * given text). A function is asked once, when a confidential call starts; one that throws (a model that will
   * not load) is a local path that is not there.
   */
  local?: unknown | ((context: CallContext) => Awaitable<unknown>);
  policy?: unknown;
  registry?: unknown;
  actions?: unknown;
  quota?: unknown;
  lease?: ReturnType<typeof createCallLease>;
  /** `create` is also given `first`, the first thing the person said (a host titles the conversation after it). */
  transcripts?: unknown;
  memory?: unknown;
  clock: Clock;
  logger?: unknown;
  catalog?: Record<string, unknown>;
  persona?: string;
  /** The host's own instructions (the whole text), or a function making them when the call starts. */
  instructions?: string | ((input: { context: CallContext; mode: string | null; now: number }) => Awaitable<string>);
  /** The host's own tools (replacing registry and actions), or a function making them when the call starts. */
  tools?: LiveTools | ((context: CallContext) => Awaitable<LiveTools>);
  /** The shapes the client speaks, when they are not this package's. */
  wire?: LiveWire;
  /** Every message the session sends, as the session writes it (before the wire changes it). A host that throws here changes nothing. */
  observe?(message: CallMessage): void;
  /** Called once, after the client is let go, with how the call ended. */
  onEnd?(info: { reason: string; code: number; startedAt: number; endedAt: number; turns: unknown[]; conversationId: string | null }): Awaitable<void>;
  resumeWindowMs?: number;
  resumeTurns?: number;
  transcriptCompleteOnly?: boolean;
  deferLatestExchange?: boolean;
  idleMs?: number;
  checkMs?: number;
  maxCallMs?: number;
  shield?: unknown;
  annotateToolResult?(name: string, result: unknown): unknown;
  /**
   * What the microphone is sorted with before it reaches the provider or the local transcription: options for
   * createMicrophoneGate (`{ vad, echo }` of @astratra/voice), a gate, or a function making either when the call
   * starts (null: no filter; one that throws: no filter either).
   */
  microphone?: MicrophoneFilters | MicrophoneGate | ((context: CallContext) => Awaitable<MicrophoneFilters | MicrophoneGate | null>) | null;
  /** The name the filters had before they served both modes. */
  directAudio?: MicrophoneFilters | MicrophoneGate | ((context: CallContext) => Awaitable<MicrophoneFilters | MicrophoneGate | null>) | null;
  /** Whether a client's `interrupt` goes to the provider when the sound goes to it as it is (default true). */
  directInterrupt?: boolean;
}): {
  start(): Promise<void>;
  receive(raw: unknown): Promise<void>;
  close(reason?: string, code?: number): Promise<void>;
  tick(): Promise<void>;
  readonly mode: string | null;
  readonly ended: boolean;
  readonly turns: unknown[];
  /** The turns of the conversation this call goes on with. */
  readonly history: unknown[];
};
export declare function attachLive(options: {
  httpServer: {
    on(event: string, listener: (...args: unknown[]) => void): void;
    off?(event: string, listener: (...args: unknown[]) => void): void;
  };
  websocketServer: {
    handleUpgrade(request: unknown, socket: unknown, head: unknown, callback: (client: Socket) => void): void;
    close?(): void;
  };
  authenticate(request: unknown): Awaitable<CallContext | null>;
  authorize?(request: unknown, context: CallContext): Awaitable<boolean | {
    allowed: boolean;
    reason?: string;
    code?: number;
  }>;
  createSession(options: {
    socket: Socket;
    context: CallContext;
  }): ReturnType<typeof createLiveSession>;
  path?: string;
  maxCalls?: number;
  logger?: unknown;
  languages?: string[];
  modes?: string[];
  conversationIdPattern?: RegExp;
  /** How the messages the server sends by itself (a refused call) are written for the client. */
  encode?(message: CallMessage): string | null;
}): {
  readonly size: number;
  close(): void;
};
