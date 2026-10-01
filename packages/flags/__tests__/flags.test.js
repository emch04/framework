const { bucket, compareVersions, createFlagProvider, createMemorySource, createUrlSource } = require('../src');

const rules = (flags) => ({ flags });

test('hachage et variante sont déterministes; la distribution suit les poids', async () => {
  const provider = createFlagProvider({ source: createMemorySource(rules({ exp: { type: 'string', default: 'none', namespace: 'exp-v1', variants: [{ name: 'a', value: 'A', weight: 50 }, { name: 'b', value: 'B', weight: 50 }] } })) });
  const counts = { A: 0, B: 0 };
  for (let i = 0; i < 10_000; i++) {
    const ctx = { targetingKey: `user-${i}` };
    const result = await provider.resolveString('exp', 'none', ctx);
    expect(result).toEqual(await provider.resolveString('exp', 'none', ctx));
    counts[result.value]++;
  }
  expect(counts.A).toBeGreaterThan(4700);
  expect(counts.A).toBeLessThan(5300);
  expect(bucket('seed', 'x')).toBe(bucket('seed', 'x'));
});

test('déploiement progressif conserve tous les utilisateurs déjà inclus', async () => {
  const source = createMemorySource(rules({ oracle: { type: 'boolean', default: false, value: true, rollout: 10 } }));
  const provider = createFlagProvider({ source });
  const before = new Set();
  for (let i = 0; i < 10_000; i++) if ((await provider.resolveBoolean('oracle', false, { targetingKey: `school-${i}` })).value) before.add(i);
  await source.set(rules({ oracle: { type: 'boolean', default: false, value: true, rollout: 50 } }));
  for (const i of before) expect((await provider.resolveBoolean('oracle', false, { targetingKey: `school-${i}` })).value).toBe(true);
  expect(before.size).toBeGreaterThan(850);
});

test('cible l utilisateur par pays, rôle et attributs d organisation', async () => {
  const p = createFlagProvider({ source: createMemorySource(rules({ oracle: { type: 'boolean', default: false, value: true, target: { country: ['FR', 'BE'], role: 'admin', organization: 'school-1' } } })) });
  const ok = await p.resolveBoolean('oracle', false, { targetingKey: 'a', attributes: { country: 'FR', role: 'admin', organization: 'school-1', platform: 'web', appVersion: '2.1' } });
  const no = await p.resolveBoolean('oracle', false, { targetingKey: 'b', attributes: { country: 'US', role: 'admin', organization: 'school-1' } });
  expect(ok).toMatchObject({ value: true, reason: 'STATIC' });
  expect(no).toMatchObject({ value: false, reason: 'TARGETING_MISMATCH' });
});

test('partage d espace de noms: deux expériences donnent la même affectation', async () => {
  const provider = createFlagProvider({ source: createMemorySource(rules({ a: { type: 'string', default: 'none', namespace: 'checkout', variants: [{ name: 'control', value: 'c', weight: 50 }, { name: 'new', value: 'n', weight: 50 }] }, b: { type: 'string', default: 'none', namespace: 'checkout', variants: [{ name: 'control', value: 'c', weight: 50 }, { name: 'new', value: 'n', weight: 50 }] } })) });
  for (let i = 0; i < 500; i++) expect((await provider.resolveString('a', '', { targetingKey: `id-${i}` })).variant).toBe((await provider.resolveString('b', '', { targetingKey: `id-${i}` })).variant);
});

test('une source en erreur conserve la dernière configuration valide et utilise le fallback au démarrage', async () => {
  let fail = false;
  const source = { async get() { if (fail) throw new Error('indisponible'); return rules({ enabled: { type: 'boolean', default: false, value: true } }); } };
  const provider = createFlagProvider({ source });
  expect((await provider.resolveBoolean('enabled')).value).toBe(true);
  fail = true;
  expect(await provider.resolveBoolean('enabled')).toMatchObject({ value: false, reason: 'ERROR' });
});

test('les résolutions instrumentent les expositions de variante', async () => {
  const events = [];
  const p = createFlagProvider({ source: createMemorySource(rules({ exp: { type: 'string', default: 'x', variants: [{ name: 'only', value: 'yes', weight: 100 }] } })), onExposure: (event) => events.push(event) });
  await p.resolveString('exp', 'x', { targetingKey: 'u1' });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ flagKey: 'exp', variant: 'only', targetingKey: 'u1' });
});


test('la source URL garde son dernier cache valide après un échec de rafraîchissement', async () => {
  let fail = false;
  const source = createUrlSource('https://flags.invalid/rules', { refreshIntervalMs: 0, fetch: async () => {
    if (fail) throw new Error('réseau indisponible');
    return { ok: true, json: async () => rules({ x: { type: 'number', default: 0, value: 7 } }) };
  } });
  expect((await source.get()).flags.x.value).toBe(7);
  fail = true;
  expect((await source.refresh()).flags.x.value).toBe(7);
  source.stop();
});

test.each([
  ['1.1.9', '1.1.9', 0], ['1.2.0', '1.2', 0], ['1.10.0', '1.9.0', 1],
  ['1.2.0-beta.1', '1.2.0', -1], ['1.2.0-beta.2', '1.2.0-beta.10', -1],
  ['1.2.0', '1.2.0+build.4', 0], ['invalid', '1.0', null]
])('compare les versions %s et %s', (a, b, expected) => {
  expect(compareVersions(a, b)).toBe(expected);
});

test('cible une application mobile iOS depuis une version minimale, avec les opérateurs de version', async () => {
  const p = createFlagProvider({ source: createMemorySource(rules({ mobile: { type: 'boolean', default: false, value: true, target: { all: [
    { platform: 'ios' }, { version: { gte: '1.1.9' } }
  ] } } })) });
  expect(await p.resolveBoolean('mobile', false, { attributes: { platform: 'ios', appVersion: '1.1.9' } })).toMatchObject({ value: true, reason: 'STATIC' });
  for (const [operator, value, actual, expected] of [
    ['>', '1.1.9', '1.2.0', true], ['<=', '1.1.9', '1.1.9', true],
    ['<', '1.1.9', '1.1.8', true], ['==', '1.2.0', '1.2', true],
    ['between', ['1.1.9', '1.2.1'], '1.2.0', true], ['>', '1.2.0', '1.2.0', false]
  ]) {
    const q = createFlagProvider({ source: createMemorySource(rules({ f: { type: 'boolean', default: false, value: true, target: { version: { [operator]: value } } } })) });
    expect((await q.resolveBoolean('f', false, { attributes: { appVersion: actual } })).value).toBe(expected);
  }
  expect((await p.resolveBoolean('mobile', false, { attributes: { platform: 'android', appVersion: '2.0' } })).reason).toBe('TARGETING_MISMATCH');
});

test('les règles numériques gèrent les bornes et refusent proprement les valeurs absentes ou invalides', async () => {
  const p = createFlagProvider({ source: createMemorySource(rules({ f: { type: 'boolean', default: false, value: true, target: { number: { attribute: 'studentCount', between: [10, 30] } } } })) });
  for (const value of [10, 20, 30]) expect((await p.resolveBoolean('f', false, { attributes: { studentCount: value } })).value).toBe(true);
  for (const attributes of [{}, { studentCount: '20' }, { studentCount: NaN }, { studentCount: Infinity }, { studentCount: 9 }, { studentCount: 31 }]) {
    expect(await p.resolveBoolean('f', false, { attributes })).toMatchObject({ value: false, reason: 'TARGETING_MISMATCH' });
  }
  for (const [operator, limit, actual] of [['>', 5, 6], ['>=', 5, 5], ['<', 5, 4], ['<=', 5, 5]]) {
    const q = createFlagProvider({ source: createMemorySource(rules({ f: { type: 'boolean', default: false, value: true, target: { number: { attribute: 'days', [operator]: limit } } } })) });
    expect((await q.resolveBoolean('f', false, { attributes: { days: actual } })).value).toBe(true);
  }
});

test('les règles composées imbriquées combinent AND et OR', async () => {
  const p = createFlagProvider({ source: createMemorySource(rules({ f: { type: 'boolean', default: false, value: true, target: { all: [
    { country: ['FR', 'BE'] }, { plan: 'pro' }, { any: [
      { all: [{ platform: 'ios' }, { version: { gte: '1.1.9' } }] },
      { number: { attribute: 'daysActive', gte: 365 } }
    ] }
  ] } } })) });
  expect((await p.resolveBoolean('f', false, { attributes: { country: 'FR', plan: 'pro', platform: 'ios', appVersion: '1.10.0' } })).value).toBe(true);
  expect((await p.resolveBoolean('f', false, { attributes: { country: 'FR', plan: 'pro', daysActive: 365 } })).value).toBe(true);
  expect((await p.resolveBoolean('f', false, { attributes: { country: 'FR', plan: 'free', daysActive: 500 } })).reason).toBe('TARGETING_MISMATCH');
});

test('les anciennes règles égalité et listes conservent leur comportement', async () => {
  const p = createFlagProvider({ source: createMemorySource(rules({ f: { type: 'boolean', default: false, value: true, target: { country: ['FR', 'BE'], role: 'admin' } } })) });
  expect((await p.resolveBoolean('f', false, { attributes: { country: 'BE', role: 'admin' } })).value).toBe(true);
  expect((await p.resolveBoolean('f', false, { attributes: { country: 'US', role: 'admin' } })).reason).toBe('TARGETING_MISMATCH');
});
