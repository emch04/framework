const { decideRegistrationAction, createNotificationRouter } = require('../src');

describe('decideRegistrationAction', () => {
  test('already granted: register the device, silently', () => {
    expect(decideRegistrationAction({ explicit: false, permission: 'granted' })).toBe('register');
    expect(decideRegistrationAction({ explicit: true, permission: 'granted' })).toBe('register');
  });

  test('never asked: only an explicit tap may raise the system prompt', () => {
    expect(decideRegistrationAction({ explicit: false, permission: 'undetermined' })).toBe('none');
    expect(decideRegistrationAction({ explicit: true, permission: 'undetermined' })).toBe('request');
  });

  test('once denied, the OS never prompts again — send them to settings', () => {
    expect(decideRegistrationAction({ explicit: true, permission: 'denied' })).toBe('open-settings');
    expect(decideRegistrationAction({ explicit: false, permission: 'denied' })).toBe('none');
  });
});

describe('createNotificationRouter', () => {
  const router = createNotificationRouter({
    fallback: '/notifications',
    routes: [
      { pattern: /^\/orders$/, allow: (role) => role === 'seller' },
      { pattern: /^\/orders\/[^/]+$/, allow: (role) => Boolean(role) },
      { pattern: /^\/billing$/, allow: (role) => role === 'owner', to: '/billing/overview' }
    ]
  });

  test('a permitted route is followed', () => {
    expect(router.resolve('/orders', 'seller')).toBe('/orders');
  });

  test('a route the recipient may not see falls back instead of opening it', () => {
    expect(router.resolve('/orders', 'courier')).toBe('/notifications');
    expect(router.resolve('/billing', 'seller')).toBe('/notifications');
  });

  test('an unknown route falls back — the list is what is allowed, not what is blocked', () => {
    expect(router.resolve('/admin/secrets', 'owner')).toBe('/notifications');
  });

  test('a rule may redirect to a different screen than the one announced', () => {
    expect(router.resolve('/billing', 'owner')).toBe('/billing/overview');
  });

  test('query strings and fragments are stripped before matching', () => {
    expect(router.resolve('/orders?from=push#top', 'seller')).toBe('/orders');
  });

  test('anything that is not a string is a fallback, not a crash', () => {
    expect(router.resolve(undefined, 'seller')).toBe('/notifications');
    expect(router.resolve(42, 'seller')).toBe('/notifications');
    expect(router.resolve('/orders', undefined)).toBe('/notifications');
  });

  test('an action button routes through its own rule, then through the same permission check', () => {
    const withActions = createNotificationRouter({
      fallback: '/notifications',
      routes: [{ pattern: /^\/orders\/[^/]+\/refund$/, allow: (role) => role === 'owner' }],
      actions: {
        REFUND: (data) => (typeof data.orderId === 'string' ? `/orders/${data.orderId}/refund` : null)
      }
    });

    expect(withActions.resolveAction({ actionIdentifier: 'REFUND', orderId: 'o1' }, 'owner')).toBe('/orders/o1/refund');
    expect(withActions.resolveAction({ actionIdentifier: 'REFUND', orderId: 'o1' }, 'clerk')).toBe('/notifications');
  });

  test('an unknown action falls back to the payload route', () => {
    const withActions = createNotificationRouter({
      fallback: '/notifications',
      routes: [{ pattern: /^\/orders$/, allow: () => true }],
      actions: {}
    });

    expect(withActions.resolveAction({ actionIdentifier: 'NOPE', route: '/orders' }, 'seller')).toBe('/orders');
  });

  test('a router with no rules always falls back', () => {
    expect(createNotificationRouter({ fallback: '/home' }).resolve('/anything', 'owner')).toBe('/home');
  });
});
