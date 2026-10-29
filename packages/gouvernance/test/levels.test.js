'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRules, decideLevel, stableStringify, digestOf, defineResources } = require('../src');

const group = (extra = {}) => ({ resource: 'products', ops: ['update'], tags: ['catalogue'], rows: 3, amount: 100, ...extra });
const decide = (rules, extra = {}) => decideLevel({ groups: [group(extra.group)], agent: extra.agent ?? 'assistant', at: extra.at ?? Date.parse('2026-11-03T10:00:00Z'), rules: normalizeRules(rules) });

test('aucune règle : validation', () => {
  assert.equal(decide([]).level, 'validation');
});

test('la règle la plus stricte l\'emporte', () => {
  assert.equal(decide([{ id: 'a', level: 'free', match: {} }, { id: 'b', level: 'free_with_notice', match: { tags: ['catalogue'] } }]).level, 'free_with_notice');
  assert.equal(decide([{ id: 'a', level: 'free', match: {} }, { id: 'b', level: 'forbidden', match: { ops: ['update'] } }]).level, 'forbidden');
});

test('critères : opération, ressource, étiquette, IA, lignes, montant', () => {
  const free = (match) => decide([{ id: 'r', level: 'free', match }]).level;
  assert.equal(free({ ops: ['delete'] }), 'validation');
  assert.equal(free({ resources: ['customers'] }), 'validation');
  assert.equal(free({ tags: ['people'] }), 'validation');
  assert.equal(free({ agents: ['other'] }), 'validation');
  assert.equal(free({ agents: ['assistant'] }), 'free');
  assert.equal(free({ rowsAbove: 2 }), 'free');
  assert.equal(free({ rowsAbove: 3 }), 'validation');
  assert.equal(free({ amountAbove: 99 }), 'free');
});

test('plage horaire dans un fuseau, y compris à cheval sur minuit', () => {
  const night = [{ id: 'day', level: 'free', match: {} }, { id: 'night', level: 'validation', match: { when: { timeZone: 'Europe/Paris', from: '22:00', to: '06:00' } } }];
  assert.equal(decide(night, { at: Date.parse('2026-11-03T22:30:00Z') }).level, 'validation', '23 h 30 à Paris');
  assert.equal(decide(night, { at: Date.parse('2026-11-03T04:30:00Z') }).level, 'validation', '5 h 30 à Paris');
  assert.equal(decide(night, { at: Date.parse('2026-11-03T05:30:00Z') }).level, 'free', '6 h 30 à Paris');
  const weekend = [{ id: 'all', level: 'free', match: {} }, { id: 'we', level: 'forbidden', match: { when: { timeZone: 'Europe/Paris', days: [6, 7] } } }];
  assert.equal(decide(weekend, { at: Date.parse('2026-11-07T12:00:00Z') }).level, 'forbidden', 'samedi');
  assert.equal(decide(weekend, { at: Date.parse('2026-11-06T12:00:00Z') }).level, 'free', 'vendredi');
});

test('le nombre d\'approbations vient des règles de validation', () => {
  assert.equal(decide([{ id: 'a', level: 'validation', approvals: 2, match: {} }]).approvals, 2);
  assert.equal(decide([{ id: 'a', level: 'free', approvals: 3, match: {} }]).approvals, 1);
});

test('règles mal formées : refusées', () => {
  for (const rules of [
    [{ id: 'a', level: 'open', match: {} }], [{ id: 'a', level: 'free', match: { sql: 'x' } }], [{ id: 'a', level: 'free' }, { id: 'a', level: 'free' }],
    [{ id: 'a', level: 'free', match: { when: { from: '22:00' } } }], [{ id: 'a', level: 'free', match: { when: { timeZone: 'Mars/Olympus', days: [1] } } }],
    [{ id: 'a', level: 'free', match: { ops: ['drop'] } }], [{ id: 'a', level: 'validation', approvals: 9 }], 'tout'
  ]) assert.throws(() => normalizeRules(rules), { code: 'invalid_rules' }, JSON.stringify(rules));
});

test('sérialisation stable : ordre des clés indifférent, valeurs ambiguës refusées', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: null }] }), '{"a":[2,{"c":null,"d":3}],"b":1}');
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
  assert.equal(stableStringify(new Date('2026-11-03T09:00:00Z')), '"2026-11-03T09:00:00.000Z"');
  for (const bad of [{ a: undefined }, NaN, Infinity, 1n, Buffer.from('x'), () => 1]) assert.throws(() => stableStringify(bad), { code: 'invalid_value' });
});

test('déclaration des ressources : clé obligatoire, clé jamais modifiable ni sensible, montant modifiable', () => {
  const bad = [
    { t: { table: 't', writable: ['a'] } },
    { t: { table: 't', key: 'id', writable: ['id'] } },
    { t: { table: 't', key: 'id', writable: ['a'], sensitive: ['id'] } },
    { t: { table: 't', key: 'id', writable: ['a'], amount: 'b' } },
    { t: { table: 't; drop table x', key: 'id', writable: ['a'] } },
    { t: { table: 't', key: 'id', writable: ['a"b'] } },
    { t: { table: 't', key: 'id', writable: ['a'], operations: ['truncate'] } }
  ];
  for (const declaration of bad) assert.throws(() => defineResources(declaration), { code: 'invalid_resources' }, JSON.stringify(declaration));
  assert.equal(defineResources({ t: { table: 'app.t', key: ['a', 'b'], writable: ['c'] } }).t.readable.join(), 'a,b,c');
});
