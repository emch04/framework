import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import {
  RequireAuth,
  RequireRole,
  SessionProvider,
  usePermissions,
  useSession,
  useUser
} from '../src/index.js';

function SessionProbe({ onValue }) {
  onValue({ session: useSession(), user: useUser(), permissions: usePermissions() });
  return null;
}

test('SessionProvider exposes the injected session and permissions', async () => {
  let value;
  await act(async () => {
    render(React.createElement(
      SessionProvider,
      { getSession: async () => ({ user: { id: 'u1', name: 'Lina' }, permissions: ['products:read'] }) },
      React.createElement(SessionProbe, { onValue: (next) => { value = next; } })
    ));
  });

  assert.equal(value.session.status, 'authenticated');
  assert.deepEqual(value.user, { id: 'u1', name: 'Lina' });
  assert.equal(value.permissions.has('products:read'), true);
  assert.equal(value.permissions.hasAny(['users:read', 'products:read']), true);
});

test('RequireAuth and RequireRole render their fallbacks when access is missing', async () => {
  let renderResult;
  await act(async () => {
    renderResult = render(React.createElement(
      SessionProvider,
      { getSession: async () => null },
      React.createElement(RequireAuth, { fallback: React.createElement('span', null, 'connexion requise') }, React.createElement('span', null, 'contenu privé'))
    ));
  });
  assert.equal(screen.getByText('connexion requise').textContent, 'connexion requise');

  await act(async () => {
    renderResult.rerender(React.createElement(
      SessionProvider,
      { getSession: async () => ({ user: { id: 'u1' }, permissions: [] }) },
      React.createElement(RequireRole, { role: 'admin', fallback: React.createElement('span', null, 'accès interdit') }, React.createElement('span', null, 'admin'))
    ));
  });
  assert.equal(screen.getByText('accès interdit').textContent, 'accès interdit');
});

test('RequireRole accepts a role from the injected session', async () => {
  await act(async () => {
    render(React.createElement(
      SessionProvider,
      { getSession: async () => ({ user: { id: 'u1', role: 'owner' } }) },
      React.createElement(RequireRole, { role: 'owner', fallback: React.createElement('span', null, 'accès interdit') }, React.createElement('span', null, 'espace propriétaire'))
    ));
  });
  assert.equal(screen.getByText('espace propriétaire').textContent, 'espace propriétaire');
});
