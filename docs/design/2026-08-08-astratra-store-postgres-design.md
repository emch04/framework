# Astratra — @astratra/store-postgres (second real persistence adapter)

## Contexte

`@astratra/store-mongo` was the first real persistence adapter for the
`usersStore`/`settingsStore` interfaces defined by `@astratra/saas-kit`.
PostgreSQL is the most commonly requested alternative for SaaS apps with
stronger relational needs. This adds a second, independent adapter — same
interface contract, different engine, no change to `saas-kit` itself.

## Adapter interfaces (unchanged, from `@astratra/saas-kit`)

```
usersStore: {
  findByEmail(email): Promise<user|null>
  findById(id): Promise<user|null>
  create(userData): Promise<user>
  list({ role, limit, offset }): Promise<user[]>
  update(id, patch): Promise<user|null>
}
settingsStore: {
  get(key): Promise<value>
  set(key, value): Promise<void>
  getAll(): Promise<{ [key]: value }>
}
```

## Package: @astratra/store-postgres

Peer dependency: `pg` (optional-meta, same pattern as `mongoose` in
`store-mongo` and `redis` in `@astratra/ai`).

### Schema strategy — stay schema-flexible like store-mongo

Postgres has no native "permissive schema" like Mongoose's `strict: false`,
so the table design mirrors that flexibility explicitly:

```sql
CREATE TABLE IF NOT EXISTS astratra_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  role TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS astratra_settings (
  key TEXT PRIMARY KEY,
  value JSONB
);
```

`email`/`role` are duplicated into their own columns purely for indexed
lookup/filtering (`findByEmail`, `list({ role })`); the full user object
(including `email`/`role` again) lives in `data` as the source of truth.
Reads merge `{ ...row.data, id: row.id }` so callers never see the
column/JSONB split. A unique index on `email` is created only when
`options.uniqueEmail` is truthy (default `true`), enforced by Postgres
itself — duplicate-email rejection reuses the database's own constraint
(error code `23505`), not an application-level pre-check.

Table/column names default to `astratra_users`/`astratra_settings` but are
configurable via `options.usersTable`/`options.settingsTable` so multiple
Astratra apps can share one database if needed.

### `createPostgresUsersStore(options)`

- `options.pool` — an existing `pg.Pool` (or anything with a compatible
  `.query()`), preferred when the consuming app already manages its own
  connection pool.
- `options.connectionString` — if no pool is given, the store creates and
  owns its own `pg.Pool`, exposing `store.disconnect()` to close it (same
  "own the connection only if you weren't handed one" rule as
  `store-mongo`).
- `findById`/`update` on a malformed UUID must return `null`, not throw
  (Postgres raises `22P02 invalid_text_representation` for a bad UUID
  literal — catch specifically that code and translate to `null`, exactly
  like `store-mongo` translates a `CastError`).
- `create` lets a genuine unique-constraint violation (`23505`) propagate
  as a real Postgres error — the spec for `store-mongo` did the same
  (native constraint, no reinvented uniqueness check).
- All returned rows are plain objects assembled from `data` + `id` — never
  a raw `pg` result row shape leaking through.

### `createPostgresSettingsStore(options)`

Same `pool`/`connectionString` options, `settingsTable` default
`astratra_settings`. `get`/`set`/`getAll` map to a straightforward
`SELECT`/`INSERT ... ON CONFLICT (key) DO UPDATE`/`SELECT *`.

## Tests

Use `pg-mem` (in-memory Postgres-compatible engine) as a devDependency, same
bar as `mongodb-memory-server` for `store-mongo` — no real Postgres
instance required to run the test suite. Cover: CRUD round-trip, role
filter + pagination in `list`, duplicate-email rejection via the real
unique constraint, settings get/set/getAll, `findById`/`update` on a
malformed id returning `null` instead of throwing, and that a `pool` passed
in by the caller is never closed by `store.disconnect()` (only
self-managed pools get closed).

## Documentation

`packages/store-postgres/README.md` in the same style as
`store-mongo/README.md`. Update the root `README.md` package table and the
persistence bullet in "Limites connues" to reflect that Postgres is now a
second real option, not just Mongo.

## Out of scope

- No query builder / ORM abstraction shared between `store-mongo` and
  `store-postgres` — each adapter is independent, matching its engine's
  idioms, same as before.
- No migrations tooling.
- No change to `@astratra/saas-kit` itself.
