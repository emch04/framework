'use strict';
const { GouvernanceError } = require('../errors');
const { defineResources, IDENTIFIER } = require('../contract');

/*
 * MongoDB : un connecteur (aperçu, revérification, écriture tout ou rien) et un magasin des propositions.
 * Ils reçoivent le `Db` et le `MongoClient` du pilote officiel et ne l'importent jamais (avec mongoose :
 * `connection.db` et `connection.getClient()`). Le tout ou rien passe par une transaction : il faut un jeu de
 * réplicas (ou un cluster). Sans lui, le connecteur refuse, sauf `transactions: false`, limité à UNE écriture par
 * proposition, revérifiée par un filtre d'égalité sur toute la ligne lue à l'aperçu.
 * Mettre le magasin dans la MÊME base : l'état « exécutée » s'écrit alors dans la même transaction que les données.
 */

const STALE = Symbol('stale');
/* Conflits de concurrence : la donnée a bougé pendant qu'on écrivait (clé en double, conflit d'écriture). */
const CONCURRENCY = new Set([11000, 112]);
const COMPARISONS = { eq: '$eq', ne: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte', in: '$in' };

/** Une valeur du pilote en JSON : ObjectId en hexadécimal, date en ISO, Decimal128 et Long en texte. */
function toJson(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value._bsontype === 'ObjectId' || value._bsontype === 'ObjectID') return value.toHexString();
    if (value._bsontype === 'Decimal128' || value._bsontype === 'Long' || value._bsontype === 'Int32' || value._bsontype === 'Double') return value.toString();
    if (value._bsontype) throw new GouvernanceError('invalid_value', `Un champ de type ${value._bsontype} ne peut pas être gouverné.`);
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) throw new GouvernanceError('invalid_value', 'Un champ d\'octets ne peut pas être gouverné.');
    if (Array.isArray(value)) return value.map(toJson);
    return Object.fromEntries(Object.keys(value).map((k) => [k, toJson(value[k])]));
  }
  return value;
}

function createMongoConnector({ db, client, resources, ObjectId, transactions = true } = {}) {
  if (!db || typeof db.collection !== 'function') throw new GouvernanceError('connector_invalid', 'Un Db du pilote MongoDB est obligatoire.');
  if (transactions && (!client || typeof client.startSession !== 'function')) throw new GouvernanceError('connector_invalid', 'Le MongoClient est obligatoire pour les transactions (ou transactions: false).');
  const declared = defineResources(resources);
  for (const resource of Object.values(declared)) {
    if (Object.values(resource.types).includes('objectId') && typeof ObjectId !== 'function') {
      throw new GouvernanceError('connector_invalid', `${resource.name} : passer ObjectId (du pilote) pour les colonnes de type objectId.`);
    }
  }

  /* Une valeur JSON de l'aperçu ou de l'IA, rendue au type de la colonne. */
  function toDb(resource, column, value) {
    if (value === null || value === undefined) return value ?? null;
    const type = resource.types[column];
    if (type === 'objectId') {
      if (typeof value !== 'string' || !/^[0-9a-f]{24}$/i.test(value)) throw new GouvernanceError('invalid_action', `${resource.name}.${column} : un identifiant de 24 caractères hexadécimaux.`);
      return new ObjectId(value);
    }
    if (type === 'date') {
      const date = new Date(value);
      if (typeof value !== 'string' || Number.isNaN(date.getTime())) throw new GouvernanceError('invalid_action', `${resource.name}.${column} : une date ISO.`);
      return date;
    }
    return value;
  }
  const project = (resource, doc) => Object.fromEntries(resource.readable.map((column) => [column, toJson(doc[column] ?? null)]));
  const projection = (resource) => Object.fromEntries(resource.readable.map((column) => [column, 1]));
  const sort = (resource) => Object.fromEntries(resource.key.map((column) => [column, 1]));

  function whereFilter(resource, where) {
    const filter = {};
    for (const [column, condition] of Object.entries(where)) {
      const parts = {};
      for (const [op, value] of Object.entries(condition)) {
        if (op === 'isNull') { Object.assign(parts, value ? { $eq: null } : { $ne: null }); continue; }
        parts[COMPARISONS[op]] = op === 'in' ? value.map((v) => toDb(resource, column, v)) : toDb(resource, column, value);
      }
      filter[column] = parts;
    }
    return filter;
  }
  const keyFilter = (resource, key) => Object.fromEntries(resource.key.map((column) => [column, toDb(resource, column, key[column])]));
  const selection = (resource, select) => (select.where ? whereFilter(resource, select.where) : { $or: select.keys.map((key) => keyFilter(resource, key)) });
  /* La ligne lue à l'aperçu, en filtre d'égalité (mode sans transaction). */
  const sameAs = (resource, row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, { $eq: toDb(resource, column, value) }]));

  async function find(resource, filter, options = {}) {
    const docs = await db.collection(resource.table).find(filter, { projection: projection(resource), sort: sort(resource), ...options }).toArray();
    return docs.map((doc) => project(resource, doc));
  }

  async function preview(action, { limit }) {
    const resource = declared[action.resource];
    const filter = action.op === 'insert' ? keyFilter(resource, action.values) : whereFilter(resource, action.where);
    return { rows: await find(resource, filter, { limit }) };
  }

  async function write(resource, w, session) {
    const collection = db.collection(resource.table);
    const options = session ? { session } : {};
    if (w.kind === 'insert') {
      for (const column of Object.keys(w.values)) if (!IDENTIFIER.test(column)) throw new GouvernanceError('invalid_action', `Champ invalide : ${column}.`);
      await collection.insertOne(Object.fromEntries(Object.entries(w.values).map(([c, v]) => [c, toDb(resource, c, v)])), options);
      return 1;
    }
    const filter = { ...keyFilter(resource, w.key), ...(w.guard ? sameAs(resource, w.guard) : {}) };
    if (w.kind === 'delete') return (await collection.deleteOne(filter, options)).deletedCount;
    const set = Object.fromEntries(Object.entries(w.set).map(([c, v]) => [c, toDb(resource, c, v)]));
    return (await collection.updateOne(filter, { $set: set }, options)).matchedCount;
  }

  let replicaSet = null;
  /** Vrai si le serveur sait faire des transactions (jeu de réplicas ou cluster). */
  async function check() {
    if (replicaSet !== null) return replicaSet;
    const hello = await db.admin().command({ hello: 1 });
    replicaSet = Boolean(hello.setName) || hello.msg === 'isdbgrid';
    return replicaSet;
  }

  async function executeInTransaction(plan, finalize) {
    if (!(await check())) throw new GouvernanceError('transactions_unavailable', 'MongoDB sans jeu de réplicas : pas de transaction, donc pas de tout ou rien (ou transactions: false, une écriture par proposition).');
    const session = client.startSession();
    let outcome = null;
    try {
      /* withTransaction rejoue l'ensemble sur une erreur passagère : la relecture et la comparaison sont rejouées aussi. */
      await session.withTransaction(async () => {
        outcome = null;
        let rowsAffected = 0;
        for (const step of plan.steps) {
          const resource = declared[step.resource];
          const found = await find(resource, selection(resource, step.select), { session });
          const problem = plan.compare(step, found);
          if (problem) { outcome = { ok: false, code: 'stale_data', detail: problem }; throw STALE; }
          for (const w of step.writes) {
            if (await write(resource, w, session) !== 1) { outcome = { ok: false, code: 'stale_data', detail: { action: step.action, reason: 'row_count' } }; throw STALE; }
            rowsAffected += 1;
          }
        }
        await finalize({ rowsAffected, client: session });
        outcome = { ok: true, rowsAffected };
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    } catch (error) {
      if (error === STALE) return outcome;
      if (CONCURRENCY.has(error.code) || (typeof error.hasErrorLabel === 'function' && error.hasErrorLabel('TransientTransactionError'))) {
        return { ok: false, code: 'stale_data', detail: { reason: 'concurrent' } };
      }
      throw error;
    } finally {
      await session.endSession();
    }
    return outcome;
  }

  /* Sans transaction : une seule écriture, filtrée par toute la ligne lue à l'aperçu ; l'état est écrit juste après. */
  async function executeAlone(plan, finalize) {
    const writes = plan.steps.reduce((n, step) => n + step.writes.length, 0);
    if (writes !== 1) throw new GouvernanceError('transactions_required', 'Sans transaction, une proposition ne peut écrire qu\'une ligne.');
    const step = plan.steps[0];
    const resource = declared[step.resource];
    const problem = plan.compare(step, await find(resource, selection(resource, step.select)));
    if (problem) return { ok: false, code: 'stale_data', detail: problem };
    const expected = step.expect[0];
    const w = { ...step.writes[0], guard: step.op === 'insert' ? null : expected?.before ?? expected?.values ?? null };
    try {
      if (await write(resource, w, null) !== 1) return { ok: false, code: 'stale_data', detail: { action: step.action, reason: 'changed' } };
    } catch (error) {
      if (CONCURRENCY.has(error.code)) return { ok: false, code: 'stale_data', detail: { reason: 'concurrent' } };
      throw error;
    }
    await finalize({ rowsAffected: 1, client: null });
    return { ok: true, rowsAffected: 1 };
  }

  async function execute(plan, { finalize }) {
    return transactions ? executeInTransaction(plan, finalize) : executeAlone(plan, finalize);
  }

  return Object.freeze({ kind: 'mongo', resources: declared, preview, execute, check });
}

/** Les index du magasin (idempotent). */
async function mongoGovernanceIndexes(db, { collection = 'gouvernance_proposals' } = {}) {
  const c = db.collection(collection);
  await c.createIndex({ organisationId: 1, id: 1 }, { unique: true, name: 'proposal_id' });
  await c.createIndex({ organisationId: 1, idempotencyKey: 1 }, { unique: true, name: 'proposal_idempotency', partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
  await c.createIndex({ organisationId: 1, status: 1, createdAt: -1 }, { name: 'proposal_status' });
}

/**
 * Magasin des propositions dans MongoDB. L'enregistrement est gardé en JSON (`data`) : les champs `$masked` de
 * l'aperçu ne deviennent jamais des clés de document. Chaque transition n'a qu'un gagnant (condition sur l'état et
 * la date de mise à jour) ; `{ client }` (une session) la fait entrer dans la transaction des données.
 */
function createMongoGovernanceStore(db, { collection = 'gouvernance_proposals' } = {}) {
  if (!db || typeof db.collection !== 'function') throw new GouvernanceError('store_invalid', 'Un Db du pilote MongoDB est obligatoire.');
  const c = () => db.collection(collection);
  const read = (doc) => (doc ? JSON.parse(doc.data) : null);
  const get = async (organisationId, id, session) => read(await c().findOne({ organisationId, id }, session ? { session } : {}));
  return Object.freeze({
    async put(record) {
      try {
        await c().insertOne({ organisationId: record.organisationId, id: record.id, digest: record.digest, status: record.status,
          idempotencyKey: record.idempotencyKey ?? null, createdAt: new Date(record.createdAt), updatedAt: record.updatedAt, data: JSON.stringify(record) });
        return { record: JSON.parse(JSON.stringify(record)), created: true };
      } catch (error) {
        if (error.code !== 11000) throw error;
        const existing = await get(record.organisationId, record.id)
          ?? (record.idempotencyKey ? read(await c().findOne({ organisationId: record.organisationId, idempotencyKey: record.idempotencyKey })) : null);
        if (!existing || existing.digest !== record.digest) throw new GouvernanceError('proposal_conflict', 'Une autre proposition porte déjà cet identifiant.');
        return { record: existing, created: false };
      }
    },
    get: (organisationId, id) => get(organisationId, id),
    async findByIdempotencyKey(organisationId, idempotencyKey) { return read(await c().findOne({ organisationId, idempotencyKey })); },
    async transition(organisationId, id, { from, to, patch = {}, at }, { client: session } = {}) {
      const options = session ? { session } : {};
      for (let essai = 0; essai < 5; essai++) {
        const doc = await c().findOne({ organisationId, id, status: { $in: from } }, options);
        if (!doc) return null;
        const record = { ...JSON.parse(doc.data), ...JSON.parse(JSON.stringify(patch)), status: to, updatedAt: at };
        const r = await c().updateOne({ _id: doc._id, status: doc.status, updatedAt: doc.updatedAt, data: doc.data },
          { $set: { status: to, updatedAt: at, data: JSON.stringify(record) } }, options);
        if (r.matchedCount === 1) return record;
      }
      return null;
    },
    async list({ organisationId, status, limit = 100 } = {}) {
      const filter = { organisationId, ...(status === undefined ? {} : { status: { $in: Array.isArray(status) ? status : [status] } }) };
      const docs = await c().find(filter, { sort: { createdAt: -1 }, limit: Math.min(Math.max(1, limit), 1000) }).toArray();
      return docs.map(read);
    }
  });
}

module.exports = { createMongoConnector, createMongoGovernanceStore, mongoGovernanceIndexes };
