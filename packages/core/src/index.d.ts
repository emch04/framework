export interface JsonResponder {
  json(payload: unknown): unknown;
}

export interface ResponseLike {
  status(statusCode: number): JsonResponder;
  setHeader?(name: string, value: string): unknown;
  set?(name: string, value: string): unknown;
}

export interface RequestLike {
  headers?: Record<string, string | undefined>;
  log?: {
    error?: (...args: unknown[]) => unknown;
  };
  originalUrl?: string;
  requestId?: string;
  url?: string;
  [key: string]: unknown;
}

export type NextFunction = (error?: unknown) => unknown;
export type RequestHandler = (req: RequestLike, res: ResponseLike, next: NextFunction) => unknown;
export type ErrorRequestHandler = (err: Error & { status?: number; statusCode?: number }, req: RequestLike, res: ResponseLike, next: NextFunction) => unknown;

export interface ApiResponsePayload<T = unknown> {
  success: boolean;
  message: string;
  data: T | null;
  timestamp: string;
  error?: string;
}

export function apiResponse<T = unknown>(
  res: ResponseLike,
  statusCode: number,
  message: string,
  data?: T | null,
  success?: boolean
): unknown;

export function asyncHandler(fn: RequestHandler): RequestHandler;

export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
}

export function createLogger(serviceName?: string): Logger;

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;
  constructor(message: string, statusCode?: number);
}

export const errorMiddleware: ErrorRequestHandler;
export function notFoundMiddleware(req: RequestLike, res: ResponseLike): unknown;
export const requestIdMiddleware: RequestHandler;

export interface ValidationLike {
  run(req: RequestLike): unknown | Promise<unknown>;
}

export function validateMiddleware(validations?: ValidationLike[]): RequestHandler;

export type EnvDefault = string | number | boolean | null | undefined;

export interface EnvDefinition<TInput = string | EnvDefault, TOutput = TInput> {
  default?: EnvDefault;
  required?: boolean;
  transform?: (value: TInput) => TOutput;
  validate?: (value: TOutput) => boolean;
}

export type EnvSchema = Record<string, EnvDefault | EnvDefinition<any, any>>;

export type LoadEnvValue<T> =
  T extends { transform: (...args: any[]) => infer R }
    ? R
    : T extends { default: infer D }
      ? D | string | undefined
      : T extends EnvDefault
        ? T | string | undefined
        : string | undefined;

export type LoadedEnv<TSchema extends EnvSchema> = {
  [K in keyof TSchema]: LoadEnvValue<TSchema[K]>;
};

export function loadEnv<TSchema extends EnvSchema = EnvSchema>(schema?: TSchema): LoadedEnv<TSchema>;
