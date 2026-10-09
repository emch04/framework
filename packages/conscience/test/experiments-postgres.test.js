'use strict';
const { after } = require('node:test');
const { randomUUID } = require('node:crypto');
const { experimentsContract } = require('./experimentsContract');
const { createPostgresConscienceStore, postgresConscienceSchema } = require('../src');
const { createPostgresGovernorStore, postgresGovernorSchema } = require('../src/governor');
const uri = process.env.CONSCIENCE_TEST_DATABASE_URL;
let safe = false;
try { const parsed = new URL(uri); safe = ['postgres:', 'postgresql:'].includes(parsed.protocol) && decodeURIComponent(parsed.pathname).endsWith('_test'); } catch (_error) { /* Integration opt-in. */ }
let pool;
after(async () => { if (pool) await pool.end(); });
experimentsContract('postgres', async () => {
  if (!pool) { const { Pool } = require('pg'); pool = new Pool({ connectionString: uri, connectionTimeoutMillis: 5000 }); }
  // An opted-in but unavailable database is a failure, never a successful skip.
  await pool.query('SELECT 1');
  const prefix = `p3c_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const governorPrefix = `p3g_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await pool.query(postgresConscienceSchema({ prefix }));
  await pool.query(postgresGovernorSchema({ prefix: governorPrefix }));
  return { store: createPostgresConscienceStore(pool, { prefix }), governorStore: createPostgresGovernorStore(pool, { prefix: governorPrefix }),
    async cleanup() {
      await pool.query(`DROP TABLE "${prefix}_records"`);
      for (const name of ['proposals', 'audit', 'spend', 'controls', 'objects', 'versions', 'findings']) await pool.query(`DROP TABLE "${governorPrefix}_${name}"`);
    }
  };
}, { skip: !safe && 'Provide a test database ending in _test' });
