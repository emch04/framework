const { randomUUID } = require('crypto');
const { createMemory, createPostgresMemoryStore, postgresMemorySchema, runStoreContract } = require('../src');
const { topicEmbed, makeClock, A } = require('./helpers');

/* ---- without a database: what is sent, and what is refused before sending ---- */

function recorder(rows = [{ paused: true, ref: 'r' }]) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: typeof rows === 'function' ? rows(sql, params) : rows, rowCount: 0 };
    }
  };
}

describe('postgres store: queries', () => {
  const hostile = "x'; DROP TABLE memories; --";

  test('everything a person controls travels as a parameter, never inside the SQL text', async () => {
    const db = recorder();
    const store = createPostgresMemoryStore(db);
    const where = { ownerId: hostile, scope: hostile };
    await store.get(where, hostile);
    await store.list(where, { kinds: [hostile], channel: hostile, supersededBy: hostile, createdAfter: new Date(0) });
    await store.update(where, hostile, { text: hostile, kind: hostile, source: { channel: hostile } });
    await store.remove(where, [hostile]);
    await store.removeAll(where);
    await store.purgeOwner(hostile);
    await store.getSettings(where);
    await store.setSettings(where, { paused: true });
    await store.claimRef(where, hostile);
    await store.releaseRef(where, hostile);
    await store.search(where, { text: hostile, vector: [1, 2], vectorSource: hostile, kinds: [hostile] });
    await store.insert({
      id: hostile, ownerId: hostile, scope: hostile, role: hostile, text: hostile, kind: hostile, importance: 3, source: { channel: hostile },
      vector: [1], vectorSource: hostile, supersededBy: null, seenAt: null, lastUsedAt: null, createdAt: new Date(), updatedAt: new Date()
    });
    expect(db.calls.length).toBeGreaterThanOrEqual(14);
    for (const call of db.calls) {
      expect(call.sql).not.toContain('DROP TABLE');
      expect(call.sql).not.toContain(hostile);
      expect(call.sql.match(/\$\d+/g) || []).not.toHaveLength(0);
    }
  });

  test('every read and write carries the owner and the scope', async () => {
    const db = recorder();
    const store = createPostgresMemoryStore(db);
    const where = { ownerId: 'u1', scope: 's1' };
    await store.get(where, 'm1');
    await store.list(where);
    await store.update(where, 'm1', { importance: 4 });
    await store.remove(where, ['m1']);
    await store.removeAll(where);
    await store.search(where, { text: 'violin' });
    for (const call of db.calls) {
      expect(call.sql).toMatch(/owner_id = \$\d/);
      expect(call.sql).toMatch(/scope = \$\d/);
      expect(call.params).toEqual(expect.arrayContaining(['u1', 's1']));
    }
  });

  test('a place or id of the wrong shape finds nothing and sends nothing', async () => {
    const db = recorder();
    const store = createPostgresMemoryStore(db, { idType: 'uuid', ownerType: 'uuid', scopeType: 'uuid' });
    const good = randomUUID();
    const bad = { ownerId: good, scope: 'not-a-uuid' };
    const ok = { ownerId: good, scope: good };
    expect(await store.get(bad, good)).toBeNull();
    expect(await store.get(ok, 'nope')).toBeNull();
    expect(await store.list(bad)).toEqual([]);
    expect(await store.update(bad, good, { importance: 2 })).toBeNull();
    expect(await store.update(ok, 'nope', { importance: 2 })).toBeNull();
    expect(await store.remove(bad, [good])).toBe(0);
    expect(await store.remove(ok, ['nope'])).toBe(0);
    expect(await store.removeAll(bad)).toBe(0);
    expect(await store.getSettings(bad)).toEqual({ paused: false });
    expect(await store.setSettings(bad, { paused: true })).toEqual({ paused: false });
    expect(await store.claimRef(bad, 'r')).toBe(false);
    expect(await store.search(bad, { text: 'a' })).toEqual({ semantic: [], lexical: [] });
    expect(await store.purgeOwner('nope')).toEqual({ memories: 0, settings: 0, refs: 0 });
    expect(db.calls).toEqual([]);
  });

  test('search is optional: without it the package ranks in process', () => {
    expect(typeof createPostgresMemoryStore(recorder()).search).toBe('function');
    expect(createPostgresMemoryStore(recorder(), { search: false }).search).toBeUndefined();
  });

  test('the vector is only read when asked, and read back from text or JSON', async () => {
    const row = { id: 'm1', owner_id: 'u', scope: 's', text: 't', kind: 'fact', importance: 2, source: '{"channel":"auto"}', vector: '[0.5,0.25]', has_vector: true, created_at: new Date(), updated_at: new Date() };
    const db = recorder([row]);
    const store = createPostgresMemoryStore(db, { vectors: 'pgvector' });
    const [light] = await store.list({ ownerId: 'u', scope: 's' }, { withVector: false });
    expect(db.calls[0].sql).toContain('NULL AS vector');
    expect(light.hasVector).toBe(true);
    const [full] = await store.list({ ownerId: 'u', scope: 's' });
    expect(full.vector).toEqual([0.5, 0.25]);
    expect(full.source).toEqual({ channel: 'auto' });
    expect(full.importance).toBe(2);
  });

  test('options are checked', () => {
    const db = recorder();
    expect(() => createPostgresMemoryStore(null)).toThrow(/query/);
    expect(() => createPostgresMemoryStore(db, { table: 'a; DROP TABLE b' })).toThrow(/identifier/);
    expect(() => createPostgresMemoryStore(db, { idType: 'int' })).toThrow(/idType/);
    expect(() => createPostgresMemoryStore(db, { textSearchConfig: "simple'); --" })).toThrow(/configuration/);
    expect(() => createPostgresMemoryStore(db, { vectors: 'faiss' })).toThrow(/vectors/);
  });
});

describe('postgres schema', () => {
  test('the default schema: three tables, indexes, generated full text column, idempotent', () => {
    const sql = postgresMemorySchema();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "memories"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "memories_settings"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "memories_refs"');
    expect(sql).toContain("to_tsvector('simple', text)");
    expect(sql).toContain('USING gin (search_vector)');
    expect(sql).toContain('vector jsonb');
    expect(sql).not.toContain('CREATE EXTENSION');
    expect(sql).toContain("scope text NOT NULL DEFAULT ''");
  });

  test('names, uuid columns, a scope that is a foreign key, another language for the search', () => {
    const sql = postgresMemorySchema({
      table: 'ia.souvenirs', idType: 'uuid', ownerType: 'uuid', scopeType: 'uuid', scopeReferences: 'organisations(id)', textSearchConfig: 'french'
    });
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "ia"."souvenirs"');
    expect(sql).toContain('"ia"."souvenirs_settings"');
    expect(sql).toContain('id uuid PRIMARY KEY');
    expect(sql).toContain('scope uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE');
    expect(sql).not.toContain("DEFAULT ''");
    expect(sql).toContain("to_tsvector('french', text)");
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS souvenirs_place_idx ON "ia"."souvenirs"');
  });

  test('pgvector needs the size of the embeddings, then adds the extension and a cosine index', () => {
    expect(() => postgresMemorySchema({ vectors: 'pgvector' })).toThrow(/vectorDimensions/);
    const sql = postgresMemorySchema({ vectors: 'pgvector', vectorDimensions: 768 });
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector;');
    expect(sql).toContain('vector vector(768)');
    expect(sql).toContain('vector_cosine_ops');
  });

  test('search: false leaves the full text column and index out', () => {
    const sql = postgresMemorySchema({ search: false });
    expect(sql).not.toContain('search_vector');
  });

  test('bad names and references are refused', () => {
    expect(() => postgresMemorySchema({ table: 'x y' })).toThrow(/identifier/);
    expect(() => postgresMemorySchema({ scopeReferences: 'organisations(id); DROP' })).toThrow(/scopeReferences/);
    expect(() => postgresMemorySchema({ vectorDimensions: 0 })).toThrow(/vectorDimensions/);
  });
});

/* ---- against a real PostgreSQL: MEMORY_TEST_DATABASE_URL=postgres:///x_test npm test -w @astratra/memory ---- */

const url = process.env.MEMORY_TEST_DATABASE_URL;
const usable = url && /_test(\?.*)?$/.test(url);
const real = usable ? describe : describe.skip;
const withVectors = usable && process.env.MEMORY_TEST_PGVECTOR === '1' ? describe : describe.skip;

if (url && !usable) throw new Error('MEMORY_TEST_DATABASE_URL must name a database ending in _test.');

real('postgres store on a real database', () => {
  let pool;
  let counter = 0;
  beforeAll(() => {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: url });
  });
  afterAll(() => pool.end());

  const fresh = async (options = {}, before = '') => {
    const table = `mem_${process.pid}_${++counter}`;
    await pool.query(`DROP TABLE IF EXISTS ${table}, ${table}_settings, ${table}_refs`);
    if (before) await pool.query(before);
    await pool.query(postgresMemorySchema({ ...options, table }));
    return { table, store: createPostgresMemoryStore(pool, { ...options, table }) };
  };

  describe('text ids', () => {
    runStoreContract(async () => (await fresh()).store);
  });

  describe('uuid ids, owners, and a scope that is a foreign key', () => {
    const owners = new Map();
    runStoreContract(async () => {
      await pool.query('CREATE TABLE IF NOT EXISTS organisations_test (id uuid PRIMARY KEY)');
      return (await fresh({ idType: 'uuid', ownerType: 'uuid', scopeType: 'uuid', scopeReferences: 'organisations_test(id)' })).store;
    }, {
      newId: randomUUID,
      makeOwner: (name) => {
        if (!owners.has(name)) owners.set(name, randomUUID());
        return owners.get(name);
      },
      makeScope: async () => {
        const id = randomUUID();
        await pool.query('INSERT INTO organisations_test (id) VALUES ($1)', [id]);
        return id;
      }
    });
    afterAll(() => pool.query('DROP TABLE IF EXISTS organisations_test CASCADE'));
  });

  test('deleting the organisation deletes its memories (foreign key)', async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS organisations_test (id uuid PRIMARY KEY)');
    const { table, store } = await fresh({ scopeType: 'uuid', scopeReferences: 'organisations_test(id)' });
    const org = randomUUID();
    await pool.query('INSERT INTO organisations_test (id) VALUES ($1)', [org]);
    const memory = createMemory({ store, now: makeClock() });
    await memory.remember({ ownerId: 'u', scope: org }, { text: 'Plays the violin', kind: 'preference' });
    await pool.query('DELETE FROM organisations_test WHERE id = $1', [org]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    await pool.query('DROP TABLE organisations_test CASCADE');
  });

  test('createMemory on it: words (full text), duplicates, reinforcement, pause, markUsed, purge', async () => {
    const { store } = await fresh();
    const memory = createMemory({ store, now: makeClock(), onDuplicate: 'reinforce' });
    const first = await memory.remember(A, { text: 'Plays the violin every evening', kind: 'preference', importance: 2 });
    await memory.remember(A, { text: 'Grows tomatoes in the garden', kind: 'fact' });
    const again = await memory.remember(A, { text: 'plays the violin every evening', kind: 'preference', importance: 5 });
    expect(again.reinforced).toBe(true);
    expect(again.memory.id).toBe(first.memory.id);
    expect(again.memory.importance).toBe(5);
    expect((await memory.list(A)).length).toBe(2);
    expect((await memory.recall(A, { query: 'violin' })).map((m) => m.text)).toEqual(['Plays the violin every evening']);
    expect((await memory.recall(A, { query: 'tomato garden' })).map((m) => m.text)).toEqual(['Grows tomatoes in the garden']);
    expect(await memory.markUsed(A, [first.memory.id, 'unknown'])).toBe(1);
    expect(await memory.pause(A)).toBe(true);
    expect((await memory.remember(A, { text: 'Anything', kind: 'fact' })).reason).toBe('paused');
    expect(await memory.resume(A)).toBe(false);
    expect(await memory.purgeOwner(A.ownerId)).toMatchObject({ memories: 2 });
  });

  test('an owner cannot reach another owner or scope', async () => {
    const { store } = await fresh();
    const memory = createMemory({ store, now: makeClock() });
    const kept = await memory.remember(A, { text: 'Secret garden plan', kind: 'fact' });
    expect(await memory.get({ ownerId: 'other', scope: A.scope }, kept.memory.id)).toBeNull();
    expect(await memory.get({ ownerId: A.ownerId, scope: 'elsewhere' }, kept.memory.id)).toBeNull();
    expect(await memory.recall({ ownerId: 'other', scope: A.scope }, { query: 'garden' })).toEqual([]);
    expect(await memory.forget({ ownerId: 'other', scope: A.scope }, kept.memory.id)).toBe(false);
  });
});

withVectors('postgres store with pgvector', () => {
  let pool;
  let counter = 0;
  beforeAll(() => {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: url });
  });
  afterAll(() => pool.end());

  const fresh = async () => {
    const table = `memv_${process.pid}_${++counter}`;
    await pool.query(`DROP TABLE IF EXISTS ${table}, ${table}_settings, ${table}_refs`);
    const options = { table, vectors: 'pgvector', vectorDimensions: 2 };
    await pool.query(postgresMemorySchema(options));
    return createPostgresMemoryStore(pool, options);
  };

  describe('the contract (vectors of two numbers)', () => {
    runStoreContract(fresh, { vectorDimensions: 2 });
  });

  test('recall by meaning goes through the vector index and ignores another source', async () => {
    const options = { table: `memv_e2e_${process.pid}`, vectors: 'pgvector', vectorDimensions: 5 };
    await pool.query(`DROP TABLE IF EXISTS ${options.table}, ${options.table}_settings, ${options.table}_refs`);
    await pool.query(postgresMemorySchema(options));
    const store = createPostgresMemoryStore(pool, options);
    const memory = createMemory({ store, now: makeClock(), embed: async (text) => ({ vector: topicEmbed(text), source: 'topics' }) });
    await memory.remember(A, { text: 'Practises the violin', kind: 'preference' });
    await memory.remember(A, { text: 'Loves maths puzzles', kind: 'preference' });
    const found = await memory.recall(A, { query: 'violin lessons' });
    expect(found[0].text).toBe('Practises the violin');
    expect(found.map((m) => m.text)).toContain('Practises the violin');
    const viaStore = await store.search(A, { text: 'zzzz', vector: topicEmbed('math'), vectorSource: 'topics' });
    expect(viaStore.semantic[0].text).toBe('Loves maths puzzles');
    expect(viaStore.semantic[0].score).toBeGreaterThan(0.99);
    expect((await store.search(A, { text: 'zzzz', vector: topicEmbed('math'), vectorSource: 'other' })).semantic).toEqual([]);
    await pool.query(`DROP TABLE ${options.table}, ${options.table}_settings, ${options.table}_refs`);
  });
});
