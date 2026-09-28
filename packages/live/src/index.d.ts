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
export declare function createGeminiLiveAdapter(options: {
  websocketFactory(url: string): unknown;
  candidates: Array<{
    model: string;
    key: string;
  }>;
  endpoint?: string;
  voice?: string;
  clock: Clock;
  openTimeoutMs?: number;
  cooldownMs?: number;
  maxHeld?: number;
  maxImageBytes?: number;
  imageEveryMs?: number;
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
export declare function createLiveSession(options: {
  socket: Socket;
  context: CallContext;
  provider?: ProviderAdapter;
  local?: unknown;
  policy?: unknown;
  registry?: unknown;
  actions?: unknown;
  quota?: unknown;
  lease?: ReturnType<typeof createCallLease>;
  transcripts?: unknown;
  memory?: unknown;
  clock: Clock;
  logger?: unknown;
  catalog?: Record<string, unknown>;
  persona?: string;
  resumeWindowMs?: number;
  resumeTurns?: number;
  transcriptCompleteOnly?: boolean;
  deferLatestExchange?: boolean;
  idleMs?: number;
  checkMs?: number;
  maxCallMs?: number;
  shield?: unknown;
  annotateToolResult?(name: string, result: unknown): unknown;
  directAudio?: {
    vad?: unknown;
    echo?: unknown;
    outputRate?: number;
  } | null;
}): {
  start(): Promise<void>;
  receive(raw: unknown): Promise<void>;
  close(reason?: string, code?: number): Promise<void>;
  tick(): Promise<void>;
  readonly mode: string | null;
  readonly ended: boolean;
  readonly turns: unknown[];
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
}): {
  readonly size: number;
  close(): void;
};
