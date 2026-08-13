import { createElement } from 'react';
import {
  ApiError,
  RequireAuth,
  RequireRole,
  Session,
  SessionProvider,
  createApiFetch,
  usePermissions,
  useSession,
  useUser
} from '@astratra/react';

const apiFetch = createApiFetch({
  baseUrl: 'https://api.example.test',
  onUnauthorized: () => undefined,
  fetchImpl: fetch
});

apiFetch('/session', { method: 'GET' });
apiFetch('/session', { method: 'POST', body: { email: 'a@b.test' } });

const error = new ApiError('failed', { status: 401, data: null, error: 'unauthorized' });
void error.status;

const session: Session = { user: { id: 'u1', role: 'owner' }, permissions: ['read'] };
void session;

createElement(
  SessionProvider,
  {
    getSession: async () => session,
    signIn: async (_credentials: unknown) => session,
    signOut: async () => undefined
  },
  createElement(RequireAuth, { fallback: null }, createElement(RequireRole, { role: 'owner', fallback: null }))
);

function Probe() {
  const { status, user, signIn, signOut, refresh } = useSession();
  void status;
  void user;
  void signIn;
  void signOut;
  void refresh;

  const currentUser = useUser();
  void currentUser;

  const { permissions, has, hasAny } = usePermissions();
  void permissions;
  const canRead: boolean = has('read');
  const canReadOrWrite: boolean = hasAny(['read', 'write']);
  void canRead;
  void canReadOrWrite;

  return null;
}
void Probe;
