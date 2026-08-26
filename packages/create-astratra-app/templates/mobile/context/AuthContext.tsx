/**
 * Who is signed in, for the whole app.
 *
 * The restore-on-launch state is the one worth naming: while the keystore is
 * being read, the answer is neither "signed in" nor "signed out". Treating it
 * as signed out flashes the sign-in screen at every cold start — which is why
 * `loading` exists and why the route guard refuses to decide during it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { router } from 'expo-router';
import { api, onSessionExpired, session } from '../services/session';
import { push } from '../services/push';

/* See app/_layout.tsx: touching the push module in Expo Go raises an error
   banner, and there is nothing to register there anyway. */
const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export type AuthUser = { id: string; email: string; role: string; fullName?: string };

type AuthValue = {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setUser(await api.request<AuthUser>('/auth/me'));
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    onSessionExpired(() => {
      if (!alive) return;
      setUser(null);
      router.replace('/login');
    });
    void (async () => {
      const token = await session.getAccessToken();
      if (token) await reload();
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [reload]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api.request<{ token: string; refreshToken?: string; user: AuthUser }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) }
    );
    /* `refreshToken` is absent unless the API enables it (saas-kit's
       `refreshTokens: { enabled: true }`). Without it the session simply ends
       when the access token expires, and the person signs in again. */
    await session.save({ accessToken: result.token, refreshToken: result.refreshToken });
    /* Signing in re-opens the door that signing out closed. */
    if (!IN_EXPO_GO) {
      push.allowRegistration();
      void push.sync();
    }
    setUser(result.user);
  }, []);

  /* Push cleanup runs BEFORE the sign-out request and cannot block it: an app
     that refuses to sign out because the network is down is a trap. */
  const signOut = useCallback(async () => {
    const cleanUpPush = IN_EXPO_GO
      ? async (signOutRequest: () => Promise<void>) => signOutRequest()
      : push.logout;

    await cleanUpPush(async () => {
      try {
        await api.request('/auth/logout', { method: 'POST' });
      } catch {
        /* signing out offline stays possible */
      }
      await session.clear();
    });
    setUser(null);
    router.replace('/login');
  }, []);

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, reload }),
    [user, loading, signIn, signOut, reload]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}
