import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const SessionContext = createContext(null);

function normalizeSession(session) {
  if (!session) return null;
  const rawRoles = session.roles ?? session.user?.roles ?? session.user?.role ?? [];
  return {
    ...session,
    permissions: Array.isArray(session.permissions) ? session.permissions : [],
    roles: Array.isArray(rawRoles) ? rawRoles : [rawRoles]
  };
}

export function SessionProvider({ children, getSession, signIn, signOut }) {
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('loading');

  const refresh = useCallback(async () => {
    if (typeof getSession !== 'function') {
      setSession(null);
      setStatus('anonymous');
      return null;
    }

    setStatus('loading');
    try {
      const nextSession = normalizeSession(await getSession());
      setSession(nextSession);
      setStatus(nextSession ? 'authenticated' : 'anonymous');
      return nextSession;
    } catch {
      setSession(null);
      setStatus('anonymous');
      return null;
    }
  }, [getSession]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (credentials) => {
    if (typeof signIn !== 'function') {
      throw new Error('SessionProvider requires signIn to authenticate a user.');
    }
    const nextSession = normalizeSession(await signIn(credentials));
    setSession(nextSession);
    setStatus(nextSession ? 'authenticated' : 'anonymous');
    return nextSession;
  }, [signIn]);

  const logout = useCallback(async () => {
    if (typeof signOut === 'function') await signOut();
    setSession(null);
    setStatus('anonymous');
  }, [signOut]);

  const value = useMemo(() => ({
    status,
    session,
    user: session?.user ?? null,
    signIn: login,
    signOut: logout,
    refresh
  }), [login, logout, refresh, session, status]);

  return createElement(SessionContext.Provider, { value }, children);
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider.');
  return value;
}

export function useUser() {
  return useSession().user;
}

export function usePermissions() {
  const { session } = useSession();
  const permissions = session?.permissions ?? [];
  return useMemo(() => ({
    permissions,
    has: (permission) => permissions.includes(permission),
    hasAny: (requiredPermissions) => requiredPermissions.some((permission) => permissions.includes(permission))
  }), [permissions]);
}

export function RequireAuth({ children, fallback = null }) {
  const { status } = useSession();
  if (status === 'loading') return null;
  return status === 'authenticated' ? children : fallback;
}

export function RequireRole({ children, fallback = null, role }) {
  const { session, status } = useSession();
  if (status === 'loading') return null;
  return status === 'authenticated' && session.roles.includes(role) ? children : fallback;
}
