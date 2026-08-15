import type { ReactElement, ReactNode } from 'react';

export class ApiError extends Error {
  status?: number;
  data?: unknown;
  error?: unknown;
  constructor(message: string, options?: { status?: number; data?: unknown; error?: unknown });
}

export interface ApiFetchOptions extends Omit<RequestInit, 'method' | 'body' | 'credentials'> {
  method?: string;
  body?: unknown;
}

export interface CreateApiFetchOptions {
  baseUrl?: string;
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
  /** Attach the CSRF header on mutating requests. Default: true. */
  csrf?: boolean;
  /** Cookie read for the token. Default: 'astratra_csrf' (matches @astratra/security). */
  csrfCookieName?: string;
  /** Header the token is sent on. Default: 'x-csrf-token' (matches @astratra/security). */
  csrfHeaderName?: string;
}

export type ApiFetch = (path: string, options?: ApiFetchOptions) => Promise<unknown>;

export function createApiFetch(options?: CreateApiFetchOptions): ApiFetch;

export interface SessionUser {
  id?: string;
  roles?: string[];
  role?: string;
  [key: string]: unknown;
}

export interface Session {
  user?: SessionUser | null;
  permissions?: string[];
  roles?: string[];
  [key: string]: unknown;
}

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

export interface SessionContextValue {
  status: SessionStatus;
  session: Session | null;
  user: SessionUser | null;
  signIn: (credentials?: unknown) => Promise<Session | null>;
  signOut: () => Promise<void>;
  refresh: () => Promise<Session | null>;
}

export interface SessionProviderProps {
  children?: ReactNode;
  getSession?: () => Promise<Session | null | undefined>;
  signIn?: (credentials?: unknown) => Promise<Session | null | undefined>;
  signOut?: () => Promise<void>;
}

export function SessionProvider(props: SessionProviderProps): ReactElement;

export function useSession(): SessionContextValue;
export function useUser(): SessionUser | null;

export interface UsePermissionsResult {
  permissions: string[];
  has: (permission: string) => boolean;
  hasAny: (permissions: string[]) => boolean;
}

export function usePermissions(): UsePermissionsResult;

export interface RequireAuthProps {
  children?: ReactNode;
  fallback?: ReactNode;
}

export function RequireAuth(props: RequireAuthProps): ReactNode;

export interface RequireRoleProps {
  children?: ReactNode;
  fallback?: ReactNode;
  role: string;
}

export function RequireRole(props: RequireRoleProps): ReactNode;
