import assert from 'node:assert/strict';
import test from 'node:test';
import { assignableRoles, canSeeView, visibleViews } from '../src/lib/access.js';

test('a member sees only the dashboard; admins and owners see every screen', () => {
  assert.deepEqual(visibleViews({ role: 'member' }), ['dashboard']);
  assert.deepEqual(visibleViews({ role: 'admin' }), ['dashboard', 'users', 'settings']);
  assert.deepEqual(visibleViews({ role: 'owner' }), ['dashboard', 'users', 'settings']);
  assert.deepEqual(visibleViews(null), [], 'nobody signed in: nothing');
  assert.deepEqual(visibleViews({}), ['dashboard'], 'no role: the shared screen only');
});

test('an unknown screen is never shown, and admin roles can be configured', () => {
  assert.equal(canSeeView('billing', { role: 'owner' }), false);
  assert.equal(canSeeView('users', { role: 'manager' }), false);
  assert.equal(canSeeView('users', { role: 'manager' }, { adminRoles: ['manager'] }), true);
});

test('admin roles are offered to owners only, as on the server', () => {
  assert.deepEqual(assignableRoles({ role: 'owner' }), ['member', 'admin', 'owner']);
  assert.deepEqual(assignableRoles({ role: 'admin' }), ['member']);
  assert.deepEqual(assignableRoles({ role: 'member' }), []);
});
