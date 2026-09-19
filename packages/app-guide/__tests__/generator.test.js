'use strict';

const {
  buildGuide,
  createTranslationResolver,
  filterGuideByRole,
  generateGuideJson,
  generateGuides
} = require('../src');
const { config, en } = require('../test-fixtures/fixture');

describe('guide generation', () => {
  const translate = createTranslationResolver(en);

  test('uses the screen configuration and resolver for every visible value', () => {
    const guide = buildGuide(config, translate);
    expect(guide.application).toBe('Example mobile application');
    expect(guide.roles.owner.sections[0].items[0]).toEqual({
      name: 'Orders', route: '/orders', visibleDirectly: false
    });
    expect(guide.tasks[0].steps).toEqual(['Open Orders.', 'Choose Create.']);
    expect(guide.pages['/orders'].actions[0]).toEqual({ label: 'Create', effect: 'Starts a new order.' });
    expect(JSON.stringify(guide)).not.toContain('pages.orders');
  });

  test('emits deterministic newline-terminated JSON per language', () => {
    const spanish = (key) => key === 'app.description' ? 'Aplicación móvil' : translate(key);
    const guides = generateGuides(config, { en: translate, es: spanish });
    expect(guides.en).toBe(generateGuideJson(config, translate));
    expect(guides.en.endsWith('\n')).toBe(true);
    expect(JSON.parse(guides.es).application).toBe('Aplicación móvil');
  });

  test('filters tasks and pages that are reachable by a role', () => {
    const filtered = filterGuideByRole(buildGuide(config, translate), 'viewer');
    expect(filtered.tasks.map((task) => task.id)).toEqual(['read-report']);
    expect(Object.keys(filtered.pages)).toEqual(['/reports']);
    expect(filterGuideByRole(buildGuide(config, translate), 'missing')).toBeNull();
  });
});
