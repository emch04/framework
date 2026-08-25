const { createPlanCatalog } = require('../src');

const build = (overrides = {}) => createPlanCatalog({
  plans: {
    free: ['dashboard'],
    starter: ['dashboard', 'reports'],
    pro: ['dashboard', 'reports', 'analytics']
  },
  labels: { free: 'Free', starter: 'Starter', pro: 'Pro' },
  upgradePath: { free: 'starter', starter: 'pro' },
  ...overrides
});

describe('plan catalog', () => {
  test('answers what a plan includes', () => {
    const catalog = build();

    expect(catalog.hasFeature('starter', 'reports')).toBe(true);
    expect(catalog.hasFeature('starter', 'analytics')).toBe(false);
  });

  test('an override grants a feature outside the plan, for one account only', () => {
    const catalog = build();

    expect(catalog.hasFeature('starter', 'analytics', ['analytics'])).toBe(true);
    expect(catalog.hasFeature('starter', 'analytics')).toBe(false);
  });

  test('an unknown plan falls back to the smallest, not to full access', () => {
    const catalog = build();

    expect(catalog.hasFeature('legacy-gold', 'dashboard')).toBe(true);
    expect(catalog.hasFeature('legacy-gold', 'analytics')).toBe(false);
    expect(catalog.knows('legacy-gold')).toBe(false);
  });

  test('the fallback plan can be chosen explicitly', () => {
    const catalog = build({ fallbackPlan: 'pro' });

    expect(catalog.hasFeature('unknown', 'analytics')).toBe(true);
  });

  test('names the next plan up, and stops at the top', () => {
    const catalog = build();

    expect(catalog.upgradeFrom('free')).toBe('starter');
    expect(catalog.upgradeFrom('pro')).toBeNull();
  });

  test('gives a human label, falling back to the key', () => {
    const catalog = build();

    expect(catalog.labelOf('pro')).toBe('Pro');
    expect(catalog.labelOf('mystery')).toBe('mystery');
  });

  test('lists the features of a plan and of the whole catalogue', () => {
    const catalog = build();

    expect(catalog.featuresOf('starter').sort()).toEqual(['dashboard', 'reports']);
    expect(catalog.allFeatures().sort()).toEqual(['analytics', 'dashboard', 'reports']);
  });

  test('a catalogue with no plans is a wiring mistake', () => {
    expect(() => createPlanCatalog({ plans: {} })).toThrow(/at least one plan/);
  });

  test('an upgrade path pointing at an unknown plan is refused up front', () => {
    expect(() => build({ upgradePath: { free: 'platinum' } })).toThrow(/unknown plan/);
  });

  test('a plan whose features are not a list is refused up front', () => {
    expect(() => createPlanCatalog({ plans: { free: 'dashboard' } })).toThrow(/array of feature keys/);
  });

  test('a fallback that is not a declared plan is refused up front', () => {
    expect(() => build({ fallbackPlan: 'ghost' })).toThrow(/not one of the declared plans/);
  });
});
