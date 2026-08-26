const { createSettingsMenu, createHomeRoutes } = require('../src');

describe('createSettingsMenu', () => {
  const menu = createSettingsMenu({
    groups: ['account', 'shop', 'support'],
    sectionGroups: { profile: 'account', security: 'account', billing: 'shop', help: 'support' }
  });

  const sections = [
    { id: 'billing', labelKey: 'billing' },
    { id: 'profile', labelKey: 'profile' },
    { id: 'help', labelKey: 'help' },
    { id: 'security', labelKey: 'security' }
  ];

  test('groups are rendered in the declared order, not in the order sections arrive', () => {
    expect(menu.group(sections).map((entry) => entry.group)).toEqual(['account', 'shop', 'support']);
  });

  test('inside a group, the original order is kept', () => {
    const [account] = menu.group(sections);

    expect(account.sections.map((section) => section.id)).toEqual(['profile', 'security']);
  });

  test('an empty group is omitted, never rendered as an empty heading', () => {
    const groups = menu.group([{ id: 'profile' }]);

    expect(groups.map((entry) => entry.group)).toEqual(['account']);
  });

  test('AN UNKNOWN SECTION IS SHOWN, NOT DROPPED — misplaced beats invisible', () => {
    const groups = menu.group([{ id: 'mystery' }]);

    expect(groups).toEqual([{ group: 'account', sections: [{ id: 'mystery' }] }]);
    expect(menu.groupOf('mystery')).toBe('account');
  });

  test('the fallback group can be chosen', () => {
    const other = createSettingsMenu({
      groups: ['a', 'b'],
      sectionGroups: {},
      fallbackGroup: 'b'
    });

    expect(other.groupOf('anything')).toBe('b');
  });

  test('sections with no id are skipped rather than crashing the screen', () => {
    expect(menu.group([null, {}, { id: 'profile' }])).toEqual([
      { group: 'account', sections: [{ id: 'profile' }] }
    ]);
  });

  test('nothing in, nothing out', () => {
    expect(menu.group([])).toEqual([]);
    expect(menu.group(undefined)).toEqual([]);
  });

  test('requires groups, and a fallback that is one of them', () => {
    expect(() => createSettingsMenu({ groups: [] })).toThrow(/groups/i);
    expect(() => createSettingsMenu({ groups: ['a'], fallbackGroup: 'z' })).toThrow(/fallback/i);
  });
});

describe('createHomeRoutes', () => {
  const home = createHomeRoutes({
    routes: { owner: '/dashboard', seller: '/dashboard', customer: '/orders' },
    fallback: '/home'
  });

  test('each role lands where it belongs', () => {
    expect(home.forRole('owner')).toBe('/dashboard');
    expect(home.forRole('customer')).toBe('/orders');
  });

  test('AN UNKNOWN ROLE FALLS BACK, it does not land on a staff screen', () => {
    expect(home.forRole('auditor')).toBe('/home');
    expect(home.forRole(undefined)).toBe('/home');
    expect(home.forRole('')).toBe('/home');
  });

  test('the fallback is the public page — signing in must not bounce back to sign-in', () => {
    expect(home.fallback).toBe('/home');
  });

  test('requires a fallback', () => {
    expect(() => createHomeRoutes({ routes: {} })).toThrow(/fallback/i);
  });
});
