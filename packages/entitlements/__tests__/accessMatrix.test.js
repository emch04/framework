const { createAccessMatrix, except } = require('../src');

const ALL = ['owner', 'admin', 'teacher', 'secretary', 'parent', 'student'];

const build = (overrides = {}) => createAccessMatrix({
  screens: {
    dashboard: ALL,
    finance: ['owner', 'admin', 'secretary'],
    grades: except(ALL, 'parent', 'student')
  },
  superRoles: ['support'],
  ...overrides
});

describe('access matrix', () => {
  test('opens a screen to the roles it lists', () => {
    const matrix = build();

    expect(matrix.canAccess('finance', 'admin')).toBe(true);
    expect(matrix.canAccess('finance', 'teacher')).toBe(false);
  });

  test('an UNKNOWN screen is closed, not open', () => {
    /* The other way round is how a screen ships without ever being added to
       the table — visible to everyone, quietly. */
    expect(build().canAccess('payroll', 'owner')).toBe(false);
    expect(build().knows('payroll')).toBe(false);
  });

  test('a super role opens everything, including screens not in the table', () => {
    const matrix = build();

    expect(matrix.canAccess('finance', 'support')).toBe(true);
    expect(matrix.canAccess('payroll', 'support')).toBe(true);
  });

  test('lists the screens a role may open — what a menu needs', () => {
    expect(build().screensFor('parent')).toEqual(['dashboard']);
    expect(build().screensFor('admin').sort()).toEqual(['dashboard', 'finance', 'grades']);
  });

  test('lists the roles allowed on a screen', () => {
    expect(build().rolesFor('finance').sort()).toEqual(['admin', 'owner', 'secretary']);
    expect(build().rolesFor('payroll')).toEqual([]);
  });

  test('names every role the table mentions, to catch a typo', () => {
    expect(build().allRoles().sort()).toEqual([...ALL, 'support'].sort());
  });

  test('except() builds a list by subtraction, without forgetting a role', () => {
    expect(except(ALL, 'parent', 'student')).toEqual(['owner', 'admin', 'teacher', 'secretary']);
    expect(except(ALL, ['parent', 'student'])).toEqual(['owner', 'admin', 'teacher', 'secretary']);
    expect(except(ALL)).toEqual(ALL);
  });

  test('an empty matrix is a wiring mistake', () => {
    expect(() => createAccessMatrix({ screens: {} })).toThrow(/at least one screen/);
  });

  test('a screen whose roles are not a list is refused up front', () => {
    expect(() => createAccessMatrix({ screens: { finance: 'admin' } })).toThrow(/array of roles/);
  });
});
