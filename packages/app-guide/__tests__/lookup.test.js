'use strict';

const { buildGuide, createTranslationResolver, lookupGuide } = require('../src');
const { config, en } = require('../test-fixtures/fixture');

describe('bounded role-aware lookup', () => {
  const guide = buildGuide(config, createTranslationResolver(en));

  test('finds tasks, a named page and its real overflow path', () => {
    const result = lookupGuide(guide, { role: 'owner', question: 'How can I create order in Orders?' });
    expect(result.tasks.map((task) => task.id)).toEqual(['create-order']);
    expect(result.pages[0]).toMatchObject({ route: '/orders', displayName: 'Orders', purpose: 'Manage orders.' });
    expect(result.paths[0]).toMatchObject({ section: 'Manage', item: 'Orders', viaOverflow: true });
  });

  test('never leaks a task hidden from the role', () => {
    const result = lookupGuide(guide, { role: 'viewer', question: 'create order' });
    expect(result.tasks).toEqual([]);
    expect(result.pages).toEqual([]);
  });

  test('bounds tasks, pages and paths even when many names match', () => {
    const broad = JSON.parse(JSON.stringify(guide));
    broad.tasks.forEach((task) => { task.keywords = ['item']; });
    broad.roles.owner.sections[0].items.forEach((item) => { item.name = 'Item'; });
    const result = lookupGuide(broad, {
      role: 'owner', question: 'item', maxTasks: 2, maxPages: 2, maxPaths: 2
    });
    expect(result.tasks).toHaveLength(2);
    expect(result.pages).toHaveLength(2);
    expect(result.paths).toHaveLength(2);
  });

  test('returns the role navigation as fallback without inventing instructions', () => {
    const result = lookupGuide(guide, { role: 'owner', question: 'unknown gesture' });
    expect(result.fallback).toBe(guide.roles.owner);
  });
});
