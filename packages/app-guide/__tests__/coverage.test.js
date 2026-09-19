'use strict';

const {
  checkActionKeysInSources,
  checkI18nKeys,
  checkPageCoverage,
  checkRoutesExist,
  collectTranslationKeys,
  createTranslationResolver
} = require('../src');
const { config, en } = require('../test-fixtures/fixture');

describe('reusable coverage checks', () => {
  const translate = createTranslationResolver(en);
  const hasTranslation = (key) => translate(key) !== key;

  test('all configured routes, pages and translations are covered', () => {
    expect(checkRoutesExist(config, (route) => ['/orders', '/reports', '/archive'].includes(route))).toEqual({
      ok: true, missing: []
    });
    expect(checkPageCoverage(config)).toEqual({ ok: true, missing: [], orphaned: [] });
    expect(checkI18nKeys(config, hasTranslation)).toEqual({ ok: true, missing: [] });
    expect(collectTranslationKeys(config)).toContain('orders.create');
  });

  test('a removed route is reported instead of leaving a drifting task', () => {
    expect(checkRoutesExist(config, (route) => route !== '/orders')).toEqual({ ok: false, missing: ['/orders'] });
  });

  test('a missing and an orphaned page are both reported', () => {
    const changed = { ...config, pages: { ...config.pages, '/unused': config.pages['/archive'] } };
    delete changed.pages['/reports'];
    expect(checkPageCoverage(changed)).toEqual({ ok: false, missing: ['/reports'], orphaned: ['/unused'] });
  });

  test('a missing translation is reported by its exact key', () => {
    expect(checkI18nKeys(config, (key) => key !== 'orders.create')).toEqual({
      ok: false, missing: ['orders.create']
    });
  });

  test('every action key must occur in one of the page screen sources', () => {
    const sources = {
      'screens/orders.js': "button(t('orders.create'))",
      'screens/reports.js': 'no matching key',
      'screens/archive.js': ''
    };
    expect(checkActionKeysInSources(config, {
      fileExists: (file) => file in sources,
      readSource: (file) => sources[file]
    })).toEqual({
      ok: false,
      missingFiles: [],
      missingActionKeys: [{ route: '/reports', key: 'reports.export' }]
    });
  });
});
