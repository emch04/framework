import {
  AppError,
  apiResponse,
  asyncHandler,
  createLogger,
  errorMiddleware,
  loadEnv,
  notFoundMiddleware,
  requestIdMiddleware,
  validateMiddleware
} from '@astratra/core';

const response = {
  status(code: number) {
    return {
      json(payload: unknown) {
        return { code, payload };
      }
    };
  },
  setHeader(_name: string, _value: string) {}
};

apiResponse(response, 200, 'ok', { id: 1 });
apiResponse(response, 500, 'bad', null, false);

asyncHandler(async (_req, _res, _next) => 'ok')({}, response, () => {});

const logger = createLogger('core');
logger.info('message', { requestId: 'req-1' });
logger.warn('message');
logger.error('message');
logger.debug('message', { debug: true });

const error = new AppError('failed', 418);
const statusCode: number = error.statusCode;
const operational: boolean = error.isOperational;

errorMiddleware(error, { requestId: 'req-1' }, response, () => {});
notFoundMiddleware({ originalUrl: '/missing' }, response);
requestIdMiddleware({ headers: { 'x-request-id': 'req-1' } }, response, () => {});

const validation = {
  async run(_req: unknown) {}
};
validateMiddleware([validation])({}, response, () => {});

const env = loadEnv({
  OPTIONAL_TEXT: 'fallback',
  REQUIRED_TEXT: { required: true },
  PORT: {
    default: '3000',
    transform: (value: string | number) => Number(value),
    validate: (value: number) => value > 0
  }
});
const port: number = env.PORT;
const text: string | undefined = env.REQUIRED_TEXT;
void statusCode;
void operational;
void port;
void text;

/* ────────────────────────── Idempotency ────────────────────────── */

import {
  createIdempotency,
  createMemoryIdempotencyStore,
  decideIdempotency,
  hashIdempotencyPayload,
  idempotencyMiddleware,
  IdempotencyError,
  isValidIdempotencyKey,
  IDEMPOTENCY_TTL_MS
} from '@astratra/core';
import type { IdempotencyStore, StoredIdempotentResponse, RequestHandler } from '@astratra/core';

const idempotencyStore: IdempotencyStore<StoredIdempotentResponse> = createMemoryIdempotencyStore<StoredIdempotentResponse>();

const guardWrites: RequestHandler = idempotencyMiddleware({
  store: idempotencyStore,
  ttlMs: IDEMPOTENCY_TTL_MS,
  identify: (req) => (req.user as { id?: string } | undefined)?.id ?? null,
  onStoreError: 'deny',
  messages: { conflict: 'Key already used for another request.' },
  respond: (res, { status, reason, message }) => res.status(status).json({ reason, message })
});

const jobs = createIdempotency<{ chargeId: string }>({ store: createMemoryIdempotencyStore(), ttlMs: 60_000 });

async function exerciseIdempotency(): Promise<void> {
  const outcome = await jobs.run({ scope: ['account-1'], key: 'intent-0001', payload: { amount: 10 } }, async () => ({ chargeId: 'c1' }));
  const chargeId: string = outcome.result.chargeId;
  const replayed: boolean = outcome.replayed;
  const claim = await jobs.begin({ scope: ['account-1'], key: 'intent-0002' });
  if (claim.action === 'execute') await claim.finish({ chargeId: 'c2' });
  try {
    await jobs.begin({ scope: ['account-1'], key: 'bad' });
  } catch (error) {
    if (error instanceof IdempotencyError) void [error.reason, error.statusCode];
  }
  void [chargeId, replayed, guardWrites, isValidIdempotencyKey('abcdefgh'), hashIdempotencyPayload({ a: 1 }),
    decideIdempotency({ record: null, payloadHash: 'h' }).action];
}

void exerciseIdempotency;
