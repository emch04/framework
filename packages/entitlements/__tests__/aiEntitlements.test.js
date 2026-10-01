const { createPlanCatalog, createAIEntitlements } = require('../src');

const catalog = createPlanCatalog({ plans: { free: ['chat'], pro: ['chat', 'vision'] } });
const modelPlans = {
  free: { groups: { small: ['tiny'], premium: ['large'] }, allowedGroups: ['small'], aliases: { default: 'tiny' }, quotas: { requestsPerMinute: 5, requestsPerDay: 20 }, budgets: { daily: 0, monthly: 0 } },
  pro: { groups: { small: ['tiny'], premium: ['large'] }, allowedGroups: ['small', 'premium'], aliases: { default: 'large' }, quotas: { requestsPerMinute: 10, tokensPerMinute: 40_000, requestsPerDay: 100 }, budgets: { daily: 10, monthly: 100 } }
};
function setup() {
  let timestamp = Date.UTC(2026, 0, 31, 23, 59);
  let plan = 'free';
  const service = createAIEntitlements({ catalog, plans: modelPlans, now: () => timestamp, resolveAccount: async () => ({ plan }) });
  return { service, setPlan: (value) => { plan = value; }, advance: (ms) => { timestamp += ms; } };
}

describe('droits IA', () => {
  test('retourne une seule fois une clé dont le store ne contient que l’empreinte', async () => {
    const { service } = setup(); const issued = await service.issueKey('compte');
    expect(issued.token).toMatch(/^ak_[0-9a-f]+_/);
    const row = await service.resolve(issued.token);
    expect(row.plan).toBe('free');
    expect(row.token).toBeUndefined();
  });
  test('les droits de la même clé suivent immédiatement la montée et la baisse de plan', async () => {
    const { service, setPlan } = setup(); const { token } = await service.issueKey('compte');
    expect((await service.resolve(token)).groups).toEqual(['small']);
    setPlan('pro'); expect((await service.resolve(token)).groups).toEqual(['small', 'premium']);
    setPlan('free'); expect((await service.resolve(token)).groups).toEqual(['small']);
  });
  test('une clé restreinte ne peut élargir groupes, alias, quotas, budgets ou fonctionnalités', async () => {
    const { service, setPlan } = setup(); setPlan('pro');
    const { token } = await service.issueKey('compte', { groups: ['small'], aliases: {}, features: ['chat'], quotas: { requestsPerMinute: 1 }, budgets: { monthly: 2 } });
    expect(await service.decide(token, 'large')).toMatchObject({ allowed: false, reason: 'model_not_allowed' });
    expect(await service.resolve(token)).toMatchObject({ groups: ['small'], aliases: {}, quotas: { requestsPerMinute: 1 }, budgets: { monthly: 2 }, features: ['chat'] });
  });
  test('refuse une clé révoquée et un secret inconnu', async () => {
    const { service } = setup(); const { id, token } = await service.issueKey('compte');
    expect((await service.resolve('secret-inconnu'))).toBeNull();
    expect(await service.revoke(id)).toBe(true);
    expect(await service.decide(token, 'tiny')).toMatchObject({ allowed: false, reason: 'invalid_key' });
  });
  test('explique les refus de modèle, quota et budget', async () => {
    const { service } = setup(); const { token } = await service.issueKey('compte');
    expect(await service.decide(token, 'large')).toMatchObject({ allowed: false, reason: 'model_not_allowed' });
    expect(await service.decide(token, 'tiny', 1)).toMatchObject({ allowed: false, reason: 'budget' });
  });
  test('refuse le repli gratuit vers un modèle payant sans budget', async () => {
    const { service } = setup(); const { token } = await service.issueKey('compte'); const calls = [];
    const result = await service.execute(token, 'tiny', (model) => model === 'tiny' ? 0 : 1, ['large'], async (model) => { calls.push(model); if (model === 'tiny') throw new Error('indisponible'); return { cost: 1 }; });
    expect(result.allowed).toBe(false);
    expect(calls).toEqual(['tiny']);
  });
  test('revérifie les budgets à chaque cible et n’appelle jamais une cible payante hors budget', async () => {
    const { service, setPlan } = setup(); setPlan('pro'); const { token } = await service.issueKey('compte'); const calls = [];
    const result = await service.execute(token, 'tiny', 11, ['large'], async (model) => { calls.push(model); return { cost: 1 }; });
    expect(result.allowed).toBe(false); expect(calls).toEqual([]);
  });
  test('réserve le coût estimé puis impute le coût réel au fournisseur retourné', async () => {
    const { service, setPlan } = setup(); setPlan('pro'); const { token } = await service.issueKey('compte');
    const result = await service.execute(token, 'tiny', 5, ['large'], async () => ({ cost: 2, tokens: 12, provider: 'fournisseur-reel' }));
    expect(result).toMatchObject({ allowed: true, model: 'tiny', cost: 2, provider: 'fournisseur-reel' });
    expect(await service.decide(token, 'tiny', 8)).toMatchObject({ allowed: true });
  });
  test('les quotas par minute et par jour se remettent à zéro aux bornes UTC', async () => {
    const { service, advance } = setup(); const { token } = await service.issueKey('compte');
    for (let i = 0; i < 5; i++) await service.execute(token, 'tiny', 0, [], async () => ({ cost: 0 }));
    expect(await service.decide(token, 'tiny')).toMatchObject({ allowed: false, reason: 'quota' });
    advance(60_000); expect(await service.decide(token, 'tiny')).toMatchObject({ allowed: true });
    advance(60_000); advance(86_400_000); expect(await service.decide(token, 'tiny')).toMatchObject({ allowed: true });
  });
  test('le plafond de jetons par minute prend en compte l’estimation du nouvel appel', async () => {
    const { service, setPlan } = setup(); setPlan('pro'); const { token } = await service.issueKey('compte');
    await service.execute(token, 'tiny', 0, [], async () => ({ cost: 0, tokens: 39_999 }));
    expect(await service.decide(token, 'tiny', 0, 2)).toMatchObject({ allowed: false, reason: 'quota', quota: 'tokensPerMinute' });
  });
  test('fenêtres de budget jour et mois distinctes', async () => {
    const { service, setPlan, advance } = setup(); setPlan('pro'); const { token } = await service.issueKey('compte');
    await service.execute(token, 'tiny', 9, [], async () => ({ cost: 9 }));
    expect(await service.decide(token, 'tiny', 2)).toMatchObject({ allowed: false, reason: 'budget' });
    advance(120_000);
    expect(await service.decide(token, 'tiny', 2)).toMatchObject({ allowed: true });
  });
});
