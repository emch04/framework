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
