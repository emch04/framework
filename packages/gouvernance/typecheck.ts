import { createDataGovernance, createMemoryGovernanceStore, createMemoryConnector, signValidation, GouvernanceError } from './src';
import type { Proposal, Rule, Validation } from './src';
import { createPostgresConnector, createPostgresGovernanceStore, postgresGovernanceSchema } from './src/postgres';

const rules: Rule[] = [{ id: 'catalogue', level: 'free_with_notice', match: { resources: ['products'], rowsAbove: 0 }, quota: { perDay: 20 } }];
const shop = createMemoryConnector({ resources: { products: { table: 'products', key: 'id', writable: ['price'], amount: 'price' } } });
const pool = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }) };
const pg = createPostgresConnector({ pool, resources: { products: { table: 'app.products', key: ['id'], writable: ['price'] } } });
const sql: string = postgresGovernanceSchema({ prefix: 'app_gouvernance' });

const governance = createDataGovernance({
  governor: { isHalted: async () => false },
  auditStore: { appendAudit: async () => undefined },
  store: process.env.PG ? createPostgresGovernanceStore(pool) : createMemoryGovernanceStore(),
  connectors: { shop, pg },
  rules,
  trust: { keys: [{ keyId: 'k', publicKey: 'MCowBQYDK2VwAyEA' }], rpId: 'example.com', origins: ['https://example.com'] }
});

async function exercise(validation: Validation) {
  const view = await governance.propose({
    organisationId: 'org', agent: { id: 'assistant' }, intent: { code: 'raise_prices', confidence: 0.9 },
    actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { id: { in: ['p1'] } }, set: { price: { multiply: 1.05, round: 0 } } }]
  });
  const proposal: Proposal | null | undefined = view.proposal;
  if (proposal) governance.challengeFor(proposal, { decision: 'approve', approver: 'a', nonce: 'n' });
  const done = await governance.applyValidation(validation, { organisationId: 'org' });
  const code: string | null = done.code;
  await governance.undo('id', { organisationId: 'org', by: { kind: 'human', id: 'owner' } });
  return [code, sql];
}

const signed: Validation = signValidation({ propositionId: 'p', digest: 'd', decision: 'approve', environment: 'production', approvals: [], issuedAt: '', expiresAt: '' }, { privateKey: 'x', keyId: 'k' });
void exercise(signed);
void new GouvernanceError('code', 'message');
