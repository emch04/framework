export interface ApiFetchOptions {
  apiUrl?: string;
  token?: string | null;
  method?: string;
  body?: unknown;
  fetcher?: typeof fetch;
  onUnauthorized?: () => void;
}
export class ApiError extends Error {
  constructor(message: string, options?: { status?: number; data?: unknown; error?: unknown });
  status?: number;
  data?: unknown;
  error?: unknown;
}
export function apiFetch<T = unknown>(path: string, options?: ApiFetchOptions): Promise<T>;
