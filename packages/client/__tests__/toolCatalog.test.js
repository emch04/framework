const { createToolCatalog } = require('../src');

const TOOLS = [
  { id: 'orders', path: '/orders', titleKey: 'orders.title', kind: 'collection', endpoint: '/orders', roles: ['owner', 'seller'] },
  { id: 'billing', path: '/billing', titleKey: 'billing.title', kind: 'summary', roles: ['owner'] },
  { id: 'profile', path: '/profile', titleKey: 'profile.title', kind: 'context', roles: ['owner', 'seller', 'courier'] }
];

describe('createToolCatalog', () => {
  const catalog = createToolCatalog(TOOLS);

  test('keeps the declared order — the order of a catalogue means something', () => {
    expect(catalog.all.map((tool) => tool.id)).toEqual(['orders', 'billing', 'profile']);
  });

  test('finds a tool by id, and answers nothing for an unknown one', () => {
    expect(catalog.byId('billing').path).toBe('/billing');
    expect(catalog.byId('nope')).toBeUndefined();
    expect(catalog.byId(undefined)).toBeUndefined();
  });

  test('access is granted by role, and refused without one', () => {
    expect(catalog.canAccess(catalog.byId('billing'), 'owner')).toBe(true);
    expect(catalog.canAccess(catalog.byId('billing'), 'seller')).toBe(false);
    expect(catalog.canAccess(catalog.byId('billing'), undefined)).toBe(false);
    expect(catalog.canAccess(undefined, 'owner')).toBe(false);
  });

  test('forRole lists what that role may see, in order', () => {
    expect(catalog.forRole('seller').map((tool) => tool.id)).toEqual(['orders', 'profile']);
    expect(catalog.forRole('courier').map((tool) => tool.id)).toEqual(['profile']);
    expect(catalog.forRole(undefined)).toEqual([]);
  });

  test('knows the paths it declares — anything else is not a tool', () => {
    expect(catalog.hasPath('/orders')).toBe(true);
    expect(catalog.hasPath('/admin/secrets')).toBe(false);
  });

  test('a tool with no endpoint needs a context first — the catalogue says which', () => {
    expect(catalog.byId('orders').endpoint).toBe('/orders');
    expect(catalog.byId('billing').endpoint).toBeUndefined();
    expect(catalog.needsContext(catalog.byId('billing'))).toBe(true);
    expect(catalog.needsContext(catalog.byId('orders'))).toBe(false);
  });

  test('refuses two tools with the same id — the second would be unreachable', () => {
    expect(() => createToolCatalog([TOOLS[0], { ...TOOLS[0] }])).toThrow(/duplicate/i);
  });

  test('refuses a tool without an id, a path or roles', () => {
    expect(() => createToolCatalog([{ path: '/x', roles: [] }])).toThrow(/id/i);
    expect(() => createToolCatalog([{ id: 'x', roles: [] }])).toThrow(/path/i);
    expect(() => createToolCatalog([{ id: 'x', path: '/x' }])).toThrow(/roles/i);
  });

  test('an empty catalogue is legal and answers empty', () => {
    const empty = createToolCatalog([]);

    expect(empty.all).toEqual([]);
    expect(empty.forRole('owner')).toEqual([]);
    expect(empty.hasPath('/orders')).toBe(false);
  });

  test('the catalogue cannot be mutated from outside', () => {
    const tools = catalog.forRole('owner');
    tools.pop();

    expect(catalog.forRole('owner')).toHaveLength(3);
  });
});
