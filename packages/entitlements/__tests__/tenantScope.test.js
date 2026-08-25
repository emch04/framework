const { createTenantScope } = require('../src');

const build = (overrides = {}) => createTenantScope({
  field: 'school',
  globalRoles: ['hero_admin', 'support'],
  ...overrides
});

describe('scoping queries', () => {
  test('a tenant user only ever queries their own tenant', () => {
    const scoped = build().scope({ role: 'director', school: 's9' }, { status: 'active' });

    expect(scoped).toEqual({ status: 'active', school: 's9' });
  });

  test('a global role sees across tenants', () => {
    expect(build().scope({ role: 'hero_admin' }, { status: 'active' })).toEqual({ status: 'active' });
  });

  test('NO TENANT MEANS NO ROWS — never all rows', () => {
    /* A half-migrated account or a stale token must get an empty screen, not
       everyone's data. The leak would look like a feature. */
    const scoped = build().scope({ role: 'teacher' }, {});

    expect(scoped.school).toBe('__no_tenant_matches_nothing__');
  });

  test('a null user fails closed too', () => {
    expect(build().scope(null, {}).school).toBe('__no_tenant_matches_nothing__');
  });

  test('a missing tenant is worth an ALARM, not just an empty screen', () => {
    const alarms = [];
    const scoped = build({ onMissingTenant: (user) => alarms.push(user.role) });

    scoped.scope({ role: 'teacher' }, {});

    expect(alarms).toEqual(['teacher']);
  });

  test('the caller query is never mutated', () => {
    const query = { status: 'active' };

    build().scope({ role: 'director', school: 's9' }, query);

    expect(query).toEqual({ status: 'active' });
  });

  test('the tenant lookup can be redefined', () => {
    const scoped = build({ tenantOf: (user) => user.org?.id });

    expect(scoped.scope({ role: 'member', org: { id: 'o7' } }, {}).school).toBe('o7');
  });

  test('the impossible value can be a store-specific sentinel', () => {
    const scoped = build({ impossibleValue: '000000000000000000000000' });

    expect(scoped.scope({ role: 'teacher' }, {}).school).toBe('000000000000000000000000');
  });
});

describe('checking one document', () => {
  test('same tenant yes, other tenant no, global role always', () => {
    const scope = build();

    expect(scope.canAccess({ role: 'director', school: 's9' }, 's9')).toBe(true);
    expect(scope.canAccess({ role: 'director', school: 's9' }, 's8')).toBe(false);
    expect(scope.canAccess({ role: 'hero_admin' }, 's8')).toBe(true);
  });

  test('an ObjectId and its string form are the same tenant', () => {
    const id = { toString: () => 'abc123' };

    expect(build().canAccess({ role: 'director', school: id }, 'abc123')).toBe(true);
  });

  test('no tenant on the user refuses everything', () => {
    expect(build().canAccess({ role: 'teacher' }, 's9')).toBe(false);
    expect(build().canAccess(null, 's9')).toBe(false);
  });
});

describe('wiring', () => {
  test('a scope without a field is refused up front', () => {
    expect(() => createTenantScope({})).toThrow(/field/);
  });
});
