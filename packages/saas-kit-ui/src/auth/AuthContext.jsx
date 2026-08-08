import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { apiFetch } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  const login = useCallback(async ({ email, password }) => {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: { email, password }
    });
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const request = useCallback((path, options = {}) => apiFetch(path, {
    ...options,
    token,
    onUnauthorized: logout
  }), [logout, token]);

  const value = useMemo(() => ({
    isAuthenticated: Boolean(token),
    token,
    user,
    login,
    logout,
    request
  }), [login, logout, request, token, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }
  return value;
}
