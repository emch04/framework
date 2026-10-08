/**
 * Reference PostgreSQL store for createMemory(): the SQL schema, parameterised
 * queries, full text search, and pgvector when the embeddings are supplied.
 *
 *   const { createMemory, createPostgresMemoryStore, postgresMemorySchema } = require('@astratra/memory');
 *   await pool.query(postgresMemorySchema());               // once, in a migration
 *   const memory = createMemory({ store: createPostgresMemoryStore(pool) });
 *
 * `db` is anything with `query(sql, params) -> { rows, rowCount }`: a pg Pool,
 * a pg client inside a transaction, a pg-mem adapter. The package does not
 * depend on `pg`.
 *
 * A place is `{ ownerId, scope }`: ownerId is the person, scope the
 * organisation or workspace. Every statement carries both. Names of tables and
 * the text search configuration come from options and are checked as plain
 * identifiers; everything that comes from a person goes through parameters.
 *
 * The scope may be a foreign key (`scopeType: 'uuid'`, `scopeReferences:
 * 'organisations(id)'` in the schema). A place whose id is not of the column's
 * shape (a scope that is not a UUID for a uuid column) finds nothing: reads
 * answer null or empty, writes count zero, nothing throws.
 */
const { cosine } = require('./ranking');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const CONFIG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMN_TYPES = ['text', 'uuid'];

function pick(value, allowed, fallback, name) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function identifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${name} must be a plain SQL identifier (letters, digits, underscore, optional schema prefix).`);
  return value.split('.').map((part) => `"${part}"`).join('.');
}

/* Index names cannot carry a schema prefix: the bare table name makes them. */
const bare = (value) => value.split('.').pop();

function normalize(options = {}) {
  const table = options.table === undefined ? 'memories' : options.table;
  const settingsTable = options.settingsTable === undefined ? `${table}_settings` : options.settingsTable;
  const refsTable = options.refsTable === undefined ? `${table}_refs` : options.refsTable;
  const textSearchConfig = options.textSearchConfig === undefined ? 'simple' : options.textSearchConfig;
  if (!CONFIG_NAME.test(textSearchConfig)) throw new Error('textSearchConfig must be a text search configuration name.');
  const vectors = pick(options.vectors, ['json', 'pgvector'], 'json', 'vectors');
  const vectorDimensions = options.vectorDimensions === undefined ? null : options.vectorDimensions;
  if (vectorDimensions !== null && !(Number.isInteger(vectorDimensions) && vectorDimensions > 0)) throw new Error('vectorDimensions must be a positive integer.');
  if (options.scopeReferences !== undefined && !/^[A-Za-z_][A-Za-z0-9_.]*\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)$/.test(options.scopeReferences)) {
    throw new Error('scopeReferences must look like "organisations(id)".');
  }
  return {
    table: identifier(table, 'table'),
    settingsTable: identifier(settingsTable, 'settingsTable'),
    refsTable: identifier(refsTable, 'refsTable'),
    names: { table: bare(table), settingsTable: bare(settingsTable), refsTable: bare(refsTable) },
    idType: pick(options.idType, COLUMN_TYPES, 'text', 'idType'),
    ownerType: pick(options.ownerType, COLUMN_TYPES, 'text', 'ownerType'),
    scopeType: pick(options.scopeType, COLUMN_TYPES, 'text', 'scopeType'),
    scopeReferences: options.scopeReferences || null,
    vectors,
    vectorDimensions,
    textSearchConfig,
    search: options.search !== false
  };
}

/**
 * The SQL that creates the tables and indexes (idempotent: IF NOT EXISTS).
 * Same options as createPostgresMemoryStore for the names and column types,
 * plus `vectorDimensions` (required with `vectors: 'pgvector'`, the size of
 * your embeddings) and `scopeReferences` ('organisations(id)': the scope
 * becomes a foreign key, memories follow the organisation when it is deleted).
 * Run it as a migration of your own.
 */
function postgresMemorySchema(options = {}) {
  const o = normalize(options);
  const pgvector = o.vectors === 'pgvector';
  if (pgvector && !o.vectorDimensions) throw new Error('vectors: "pgvector" needs vectorDimensions.');
  const scopeDefault = o.scopeType === 'text' ? " DEFAULT ''" : '';
  const reference = o.scopeReferences ? ` REFERENCES ${o.scopeReferences} ON DELETE CASCADE` : '';
  const scopeColumn = `scope ${o.scopeType} NOT NULL${scopeDefault}${reference}`;
  const n = o.names;
  const out = [];
  if (pgvector) out.push('CREATE EXTENSION IF NOT EXISTS vector;');
  out.push(`CREATE TABLE IF NOT EXISTS ${o.table} (
  id ${o.idType} PRIMARY KEY,
  owner_id ${o.ownerType} NOT NULL,
  ${scopeColumn},
  role text,
  text text NOT NULL,
  kind text NOT NULL,
  importance smallint NOT NULL DEFAULT 3,
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  vector ${pgvector ? `vector(${o.vectorDimensions})` : 'jsonb'},
  vector_source text,
  superseded_by ${o.idType},
  seen_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL${o.search ? `,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('${o.textSearchConfig}', text)) STORED` : ''}
);`);
  out.push(`CREATE INDEX IF NOT EXISTS ${n.table}_place_idx ON ${o.table} (owner_id, scope, created_at DESC);`);
  out.push(`CREATE INDEX IF NOT EXISTS ${n.table}_superseded_idx ON ${o.table} (owner_id, scope, superseded_by);`);
  if (o.search) out.push(`CREATE INDEX IF NOT EXISTS ${n.table}_search_idx ON ${o.table} USING gin (search_vector);`);
  if (pgvector) out.push(`CREATE INDEX IF NOT EXISTS ${n.table}_vector_idx ON ${o.table} USING hnsw (vector vector_cosine_ops);`);
  out.push(`CREATE TABLE IF NOT EXISTS ${o.settingsTable} (
  owner_id ${o.ownerType} NOT NULL,
  ${scopeColumn},
  paused boolean NOT NULL DEFAULT false,
  PRIMARY KEY (owner_id, scope)
);`);
  out.push(`CREATE TABLE IF NOT EXISTS ${o.refsTable} (
  owner_id ${o.ownerType} NOT NULL,
  ${scopeColumn},
  ref text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, scope, ref)
);`);
  return `${out.join('\n')}\n`;
}

/** Words of a query joined with "or", for to_tsquery: at most 16, letters and digits only (nothing to escape). */
function tsQueryOf(text) {
  const words = [...new Set(String(text || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])].slice(0, 16);
  return words.length ? words.join(' | ') : null;
}

/* The fields a patch may change, and their columns. id, ownerId and scope never change. */
const PATCH_COLUMNS = {
  text: 'text',
  kind: 'kind',
  importance: 'importance',
  role: 'role',
  supersededBy: 'superseded_by',
  seenAt: 'seen_at',
  lastUsedAt: 'last_used_at',
  updatedAt: 'updated_at',
  createdAt: 'created_at',
  vectorSource: 'vector_source'
};

/**
 * @param {{ query(sql: string, params?: unknown[]): Promise<{ rows: any[], rowCount?: number | null }> }} db
 * @param {object} [options] see index.d.ts (PostgresMemoryStoreOptions).
 */
function createPostgresMemoryStore(db, options = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('createPostgresMemoryStore requires a db with query(sql, params).');
  const o = normalize(options);
  const pgvector = o.vectors === 'pgvector';
  const shaped = { id: o.idType, ownerId: o.ownerType, scope: o.scopeType };

  const okId = (value) => typeof value === 'string' && value !== '' && (o.idType === 'text' || UUID.test(value));
  const okPlace = (where) => Boolean(where) && typeof where.ownerId === 'string' && where.ownerId !== ''
    && typeof where.scope === 'string'
    && (shaped.ownerId === 'text' || UUID.test(where.ownerId))
    && (shaped.scope === 'text' ? true : UUID.test(where.scope));
  const goodIds = (ids) => [...new Set((ids || []).map(String))].filter(okId);

  const vectorText = (vector) => (Array.isArray(vector) && vector.length ? JSON.stringify(vector) : null);
  const readVector = (value) => {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value); } catch (_error) { return null; }
  };

  /* The columns read back. The vector is left out when the caller says it will not read it. */
  const columns = (withVector) => {
    const vector = pgvector ? 'vector::text' : 'vector';
    return `id, owner_id, scope, role, text, kind, importance, source, vector_source, superseded_by, seen_at, last_used_at, created_at, updated_at,
      ${withVector ? vector : 'NULL'} AS vector, (vector IS NOT NULL) AS has_vector`;
  };

  function toRecord(row) {
    const vector = readVector(row.vector);
    const out = {
      id: row.id,
      ownerId: row.owner_id,
      scope: row.scope,
      role: row.role ?? null,
      text: row.text,
      kind: row.kind,
      importance: Number(row.importance),
      source: (typeof row.source === 'string' ? JSON.parse(row.source) : row.source) || {},
      vector,
      vectorSource: row.vector_source ?? null,
      supersededBy: row.superseded_by ?? null,
      seenAt: row.seen_at ?? null,
      lastUsedAt: row.last_used_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      hasVector: Boolean(row.has_vector)
    };
    if (row.score !== undefined && row.score !== null) out.score = Number(row.score);
    return out;
  }

  /* The conditions shared by reads. Parameters $1 and $2 are always the place. */
  function conditions(filter = {}, startAt = 3) {
    const sql = [];
    const params = [];
    const add = (value) => { params.push(value); return `$${startAt + params.length - 1}`; };
    const state = filter.state || 'active';
    if (state === 'active') sql.push('superseded_by IS NULL');
    if (state === 'superseded') sql.push('superseded_by IS NOT NULL');
    if (filter.supersededBy !== undefined) sql.push(okId(String(filter.supersededBy)) ? `superseded_by = ${add(String(filter.supersededBy))}` : 'false');
    if (Array.isArray(filter.kinds)) sql.push(`kind = ANY(${add(filter.kinds.map(String))}::text[])`);
    if (filter.channel !== undefined) sql.push(`source->>'channel' = ${add(String(filter.channel))}`);
    if (filter.seen === true) sql.push('seen_at IS NOT NULL');
    else if (filter.seen === false) sql.push('seen_at IS NULL');
    if (filter.createdAfter) sql.push(`created_at >= ${add(new Date(filter.createdAfter))}`);
    if (filter.createdBefore) sql.push(`created_at <= ${add(new Date(filter.createdBefore))}`);
    return { sql: sql.length ? ` AND ${sql.join(' AND ')}` : '', params };
  }

  const placeSql = 'owner_id = $1 AND scope = $2';

  async function one(where, id, extra = '') {
    if (!okPlace(where) || !okId(String(id))) return null;
    const result = await db.query(`SELECT ${columns(true)} FROM ${o.table} WHERE id = $1 AND owner_id = $2 AND scope = $3${extra}`, [String(id), where.ownerId, where.scope]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  const store = {
    async insert(record) {
      if (!record || !record.id) throw new Error('insert requires a record with an id.');
      const result = await db.query(
        `INSERT INTO ${o.table} (id, owner_id, scope, role, text, kind, importance, source, vector, vector_source, superseded_by, seen_at, last_used_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9${pgvector ? '::vector' : '::jsonb'}, $10, $11, $12, $13, $14, $15)
         RETURNING ${columns(true)}`,
        [record.id, record.ownerId, record.scope, record.role ?? null, record.text, record.kind, record.importance, JSON.stringify(record.source || {}),
          vectorText(record.vector), record.vectorSource ?? null, record.supersededBy ?? null, record.seenAt ?? null, record.lastUsedAt ?? null,
          record.createdAt, record.updatedAt]
      );
      return toRecord(result.rows[0]);
    },

    get: (where, id) => one(where, id),

    async list(where, filter = {}) {
      if (!okPlace(where)) return [];
      const c = conditions(filter);
      const limit = filter.limit ? ` LIMIT ${Math.max(1, Math.floor(Number(filter.limit)))}` : '';
      const result = await db.query(
        `SELECT ${columns(filter.withVector !== false)} FROM ${o.table} WHERE ${placeSql}${c.sql} ORDER BY created_at DESC, id${limit}`,
        [where.ownerId, where.scope, ...c.params]
      );
      return result.rows.map(toRecord);
    },

    async update(where, id, patch = {}, options = {}) {
      const onlyActive = options.onlyActive ? ' AND superseded_by IS NULL' : '';
      const sets = [];
      const params = [];
      const set = (column, value, cast = '') => { params.push(value); sets.push(`${column} = $${params.length + 3}${cast}`); };
      for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
        if (field in patch) set(column, patch[field] === undefined ? null : patch[field]);
      }
      if ('source' in patch) set('source', JSON.stringify(patch.source || {}), '::jsonb');
      if ('vector' in patch) set('vector', vectorText(patch.vector), pgvector ? '::vector' : '::jsonb');
      if (!sets.length) return one(where, id, onlyActive);
      if (!okPlace(where) || !okId(String(id))) return null;
      if ('supersededBy' in patch && patch.supersededBy !== null && patch.supersededBy !== undefined && !okId(String(patch.supersededBy))) return null;
      const result = await db.query(
        `UPDATE ${o.table} SET ${sets.join(', ')} WHERE id = $1 AND owner_id = $2 AND scope = $3${onlyActive} RETURNING ${columns(true)}`,
        [String(id), where.ownerId, where.scope, ...params]
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async remove(where, ids) {
      const good = goodIds(ids);
      if (!okPlace(where) || !good.length) return 0;
      const result = await db.query(`DELETE FROM ${o.table} WHERE ${placeSql} AND id = ANY($3::${o.idType}[])`, [where.ownerId, where.scope, good]);
      return result.rowCount ?? 0;
    },

    async removeAll(where) {
      if (!okPlace(where)) return 0;
      const result = await db.query(`DELETE FROM ${o.table} WHERE ${placeSql}`, [where.ownerId, where.scope]);
      return result.rowCount ?? 0;
    },

    /* Right to erasure: this owner in every scope — memories, settings and consolidation marks. */
    async purgeOwner(ownerId) {
      const owner = String(ownerId ?? '');
      if (!owner || (shaped.ownerId === 'uuid' && !UUID.test(owner))) return { memories: 0, settings: 0, refs: 0 };
      const count = async (table) => (await db.query(`DELETE FROM ${table} WHERE owner_id = $1`, [owner])).rowCount ?? 0;
      return { memories: await count(o.table), settings: await count(o.settingsTable), refs: await count(o.refsTable) };
    },

    async getSettings(where) {
      if (!okPlace(where)) return { paused: false };
      const result = await db.query(`SELECT paused FROM ${o.settingsTable} WHERE ${placeSql}`, [where.ownerId, where.scope]);
      return { paused: Boolean(result.rows[0] && result.rows[0].paused) };
    },

    /* Only `paused` is kept in settings. */
    async setSettings(where, patch = {}) {
      if (!okPlace(where)) return { paused: false };
      const result = await db.query(
        `INSERT INTO ${o.settingsTable} (owner_id, scope, paused) VALUES ($1, $2, $3)
         ON CONFLICT (owner_id, scope) DO UPDATE SET paused = COALESCE($4, ${o.settingsTable}.paused)
         RETURNING paused`,
        [where.ownerId, where.scope, Boolean(patch.paused), patch.paused === undefined ? null : Boolean(patch.paused)]
      );
      return { paused: Boolean(result.rows[0].paused) };
    },

    async claimRef(where, ref) {
      if (!okPlace(where)) return false;
      const result = await db.query(
        `INSERT INTO ${o.refsTable} (owner_id, scope, ref) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING ref`,
        [where.ownerId, where.scope, String(ref)]
      );
      return result.rows.length > 0;
    },

    async releaseRef(where, ref) {
      if (!okPlace(where)) return;
      await db.query(`DELETE FROM ${o.refsTable} WHERE ${placeSql} AND ref = $3`, [where.ownerId, where.scope, String(ref)]);
    },

    /* Active memories, every owner, with no vector or one from another source. */
    async listNeedingVector({ limit = 50, source } = {}) {
      const result = await db.query(
        `SELECT ${columns(true)} FROM ${o.table}
         WHERE superseded_by IS NULL AND (vector IS NULL OR ($1::text IS NOT NULL AND vector_source IS DISTINCT FROM $1::text))
         ORDER BY (vector IS NOT NULL), created_at LIMIT $2`,
        [source ?? null, Math.max(1, Math.floor(Number(limit)))]
      );
      return result.rows.map(toRecord);
    }
  };

  if (o.search) {
    /*
     * Candidates for recall. By words: full text search (OR of the words,
     * ranked), then, when no word matches, by fragment. By meaning: pgvector's
     * cosine distance, or without pgvector the cosine computed here over the
     * vectors of the same source. Active memories only.
     */
    store.search = async function search(where, { text, vector, vectorSource, kinds, createdAfter, createdBefore, limit = 32 } = {}) {
      if (!okPlace(where)) return { semantic: [], lexical: [] };
      const c = conditions({ kinds, createdAfter, createdBefore });
      const bound = Math.max(1, Math.floor(Number(limit)));
      const base = [where.ownerId, where.scope, ...c.params];
      const next = base.length + 1;

      let lexical = [];
      const query = text ? tsQueryOf(text) : null;
      if (query) {
        const result = await db.query(
          `SELECT ${columns(false)}, ts_rank(search_vector, to_tsquery('${o.textSearchConfig}', $${next})) AS score FROM ${o.table}
           WHERE ${placeSql}${c.sql} AND search_vector @@ to_tsquery('${o.textSearchConfig}', $${next})
           ORDER BY score DESC, importance DESC, updated_at DESC LIMIT ${bound}`,
          [...base, query]
        );
        lexical = result.rows.map(toRecord);
      }
      if (!lexical.length && text && String(text).trim()) {
        const fragment = `%${String(text).trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        const result = await db.query(
          `SELECT ${columns(false)}, 0.1 AS score FROM ${o.table}
           WHERE ${placeSql}${c.sql} AND text ILIKE $${next}
           ORDER BY importance DESC, updated_at DESC LIMIT ${bound}`,
          [...base, fragment]
        );
        lexical = result.rows.map(toRecord);
      }

      let semantic = [];
      if (Array.isArray(vector) && vector.length) {
        if (pgvector) {
          const result = await db.query(
            `SELECT ${columns(true)}, 1 - (vector <=> $${next}::vector) AS score FROM ${o.table}
             WHERE ${placeSql}${c.sql} AND vector IS NOT NULL AND vector_source IS NOT DISTINCT FROM $${next + 1}::text AND vector_dims(vector) = $${next + 2}
             ORDER BY vector <=> $${next}::vector LIMIT ${bound}`,
            [...base, JSON.stringify(vector), vectorSource ?? null, vector.length]
          );
          semantic = result.rows.map(toRecord);
        } else {
          const result = await db.query(
            `SELECT ${columns(true)} FROM ${o.table}
             WHERE ${placeSql}${c.sql} AND vector IS NOT NULL AND vector_source IS NOT DISTINCT FROM $${next}::text`,
            [...base, vectorSource ?? null]
          );
          semantic = result.rows.map(toRecord)
            .filter((row) => Array.isArray(row.vector) && row.vector.length === vector.length)
            .map((row) => ({ ...row, score: cosine(vector, row.vector) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, bound);
        }
      }
      return { semantic, lexical };
    };
  }

  return store;
}

module.exports = { createPostgresMemoryStore, postgresMemorySchema };
