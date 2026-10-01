/**
 * Stockage des rendez-vous, avec la seule garantie qui compte : deux
 * réservations concurrentes sur la même ressource ne se croisent jamais.
 *
 * Contrat attendu par `createBookingService` :
 *
 *   listBookings(resourceId, from, to)  → rendez-vous actifs qui chevauchent [from, to)
 *   getBooking(id)                       → rendez-vous ou null
 *   transaction(resourceIds, travail)    → exécute `travail(tx)` en EXCLUSIVITÉ
 *        sur ces ressources ; tx offre listBookings, getBooking, insert, update.
 *        Tant que `travail` tourne, aucune autre transaction ne touche ces
 *        ressources : la vérification « le créneau est-il libre ? » et
 *        l'écriture se font d'un seul tenant. Si `travail` lève, rien n'est écrit.
 *
 * Les dates circulent en chaînes ISO 8601 (UTC).
 */

const { randomUUID } = require('node:crypto');

const STORE_METHODS = ['listBookings', 'getBooking', 'transaction'];

function assertBookingStore(store) {
  for (const methode of STORE_METHODS) {
    if (typeof store?.[methode] !== 'function') throw new TypeError(`store.${methode} doit être une fonction.`);
  }
  return store;
}

/* Copie profonde : un appelant ne doit jamais modifier le stock par référence. */
const copier = (valeur) => globalThis.structuredClone(valeur);
const ordonner = (resourceIds) => [...new Set(resourceIds.map(String))].sort();
const chevauche = (b, from, to) => b.status !== 'cancelled' && Date.parse(b.start) < Date.parse(to) && Date.parse(b.end) > Date.parse(from);

/* ---------- Mémoire ---------- */

function createMemoryBookingStore() {
  const rendezVous = new Map();
  const files = new Map(); // ressource → fin de la file d'attente

  /* Verrou par ressource : une file de promesses. Plusieurs ressources se
     prennent toujours dans le même ordre, sinon deux transactions croisées
     s'attendraient l'une l'autre pour toujours. */
  async function prendre(resourceIds) {
    const liberations = [];
    for (const id of ordonner(resourceIds)) {
      const precedente = files.get(id) || Promise.resolve();
      let liberer;
      const tour = new Promise((resolve) => { liberer = resolve; });
      const fin = precedente.then(() => tour);
      files.set(id, fin);
      await precedente;
      liberations.push(() => {
        liberer();
        if (files.get(id) === fin) files.delete(id);
      });
    }
    return () => liberations.reverse().forEach((liberer) => liberer());
  }

  const lister = (resourceId, from, to) =>
    [...rendezVous.values()]
      .filter((b) => b.resourceIds.includes(String(resourceId)) && chevauche(b, from, to))
      .map((b) => copier(b));

  return {
    async listBookings(resourceId, from, to) {
      return lister(resourceId, from, to);
    },
    async getBooking(id) {
      const b = rendezVous.get(id);
      return b ? copier(b) : null;
    },
    async transaction(resourceIds, travail) {
      const liberer = await prendre(resourceIds);
      try {
        const ecritures = [];
        const resultat = await travail({
          listBookings: async (resourceId, from, to) => lister(resourceId, from, to),
          getBooking: async (id) => (rendezVous.has(id) ? copier(rendezVous.get(id)) : null),
          insert: async (booking) => { ecritures.push(() => rendezVous.set(booking.id, copier(booking))); },
          update: async (id, patch) => { ecritures.push(() => rendezVous.set(id, { ...rendezVous.get(id), ...copier(patch) })); }
        });
        // Rien n'est écrit si le travail a levé : les écritures partent ensemble à la fin.
        for (const ecrire of ecritures) ecrire();
        return resultat;
      } finally {
        liberer();
      }
    }
  };
}

/* ---------- PostgreSQL ---------- */

const IDENTIFIANT_SQL = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/**
 * Verrou : une ligne par ressource dans `<prefix>locks`, prise par
 * `SELECT … FOR UPDATE` au début de la transaction. Une autre transaction
 * sur la même ressource attend le COMMIT, puis relit les rendez-vous à jour.
 *
 * @param {object} options
 * @param {{ connect(): Promise<{ query: Function, release: Function }> }} options.pool un `Pool` de `pg`.
 */
function createPostgresBookingStore({ pool, prefix = 'booking_' } = {}) {
  if (typeof pool?.connect !== 'function' || typeof pool?.query !== 'function') {
    throw new TypeError('pool doit être un Pool pg (query et connect).');
  }
  if (!IDENTIFIANT_SQL.test(prefix)) throw new TypeError(`Préfixe de table invalide : ${prefix}`);
  const tRdv = `${prefix}bookings`;
  const tVerrous = `${prefix}locks`;

  let pret = null;
  const preparer = () => {
    pret ||= (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${tRdv} (
        id TEXT PRIMARY KEY,
        resource_ids TEXT[] NOT NULL,
        start_at TIMESTAMPTZ NOT NULL,
        end_at TIMESTAMPTZ NOT NULL,
        buffer_before INTEGER NOT NULL DEFAULT 0,
        buffer_after INTEGER NOT NULL DEFAULT 0,
        seats INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        service_id TEXT,
        data JSONB,
        history JSONB NOT NULL DEFAULT '[]',
        cancel_reason TEXT,
        cancelled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS ${tRdv}_period_idx ON ${tRdv} (start_at, end_at)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS ${tVerrous} (resource_id TEXT PRIMARY KEY)`);
    })().catch((erreur) => {
      pret = null;
      throw erreur;
    });
    return pret;
  };

  const versRdv = (l) => ({
    id: l.id,
    resourceIds: l.resource_ids,
    start: new Date(l.start_at).toISOString(),
    end: new Date(l.end_at).toISOString(),
    bufferBefore: Number(l.buffer_before),
    bufferAfter: Number(l.buffer_after),
    seats: Number(l.seats),
    status: l.status,
    serviceId: l.service_id,
    data: l.data ?? null,
    history: l.history || [],
    cancelReason: l.cancel_reason,
    cancelledAt: l.cancelled_at ? new Date(l.cancelled_at).toISOString() : null,
    createdAt: new Date(l.created_at).toISOString(),
    updatedAt: new Date(l.updated_at).toISOString()
  });

  const COLONNES = {
    resourceIds: 'resource_ids',
    start: 'start_at',
    end: 'end_at',
    bufferBefore: 'buffer_before',
    bufferAfter: 'buffer_after',
    seats: 'seats',
    status: 'status',
    serviceId: 'service_id',
    data: 'data',
    history: 'history',
    cancelReason: 'cancel_reason',
    cancelledAt: 'cancelled_at',
    updatedAt: 'updated_at'
  };
  const JSON_COLONNES = new Set(['data', 'history']);

  function operations(executer) {
    return {
      async listBookings(resourceId, from, to) {
        const { rows } = await executer(
          `SELECT * FROM ${tRdv} WHERE $1 = ANY(resource_ids) AND status <> 'cancelled' AND start_at < $3 AND end_at > $2 ORDER BY start_at`,
          [String(resourceId), from, to]
        );
        return rows.map(versRdv);
      },
      async getBooking(id) {
        const { rows } = await executer(`SELECT * FROM ${tRdv} WHERE id = $1`, [id]);
        return rows.length ? versRdv(rows[0]) : null;
      },
      async insert(b) {
        await executer(
          `INSERT INTO ${tRdv} (id, resource_ids, start_at, end_at, buffer_before, buffer_after, seats, status, service_id, data, history, cancel_reason, cancelled_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [b.id, b.resourceIds, b.start, b.end, b.bufferBefore, b.bufferAfter, b.seats, b.status, b.serviceId, JSON.stringify(b.data ?? null), JSON.stringify(b.history || []), b.cancelReason, b.cancelledAt, b.createdAt, b.updatedAt]
        );
      },
      async update(id, patch) {
        const champs = Object.keys(patch).filter((cle) => COLONNES[cle]);
        if (!champs.length) return;
        const valeurs = champs.map((cle) => (JSON_COLONNES.has(cle) ? JSON.stringify(patch[cle]) : patch[cle]));
        const affectations = champs.map((cle, i) => `${COLONNES[cle]} = $${i + 2}`).join(', ');
        await executer(`UPDATE ${tRdv} SET ${affectations} WHERE id = $1`, [id, ...valeurs]);
      }
    };
  }

  const horsTransaction = operations((texte, valeurs) => pool.query(texte, valeurs));

  return {
    async listBookings(resourceId, from, to) {
      await preparer();
      return horsTransaction.listBookings(resourceId, from, to);
    },
    async getBooking(id) {
      await preparer();
      return horsTransaction.getBooking(id);
    },
    async transaction(resourceIds, travail) {
      await preparer();
      const ids = ordonner(resourceIds);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const id of ids) await client.query(`INSERT INTO ${tVerrous} (resource_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
        await client.query(`SELECT resource_id FROM ${tVerrous} WHERE resource_id = ANY($1) ORDER BY resource_id FOR UPDATE`, [ids]);
        const resultat = await travail(operations((texte, valeurs) => client.query(texte, valeurs)));
        await client.query('COMMIT');
        return resultat;
      } catch (erreur) {
        await client.query('ROLLBACK').catch(() => {});
        throw erreur;
      } finally {
        client.release();
      }
    }
  };
}

/* ---------- MongoDB ---------- */

/**
 * Sans transactions multi-documents (un MongoDB seul, sans jeu de réplicas,
 * n'en a pas) : le verrou est un bail. Un document par ressource dans
 * `<prefix>locks`, inséré par le détenteur ; son `_id` unique empêche un
 * second détenteur. Un bail expiré (processus mort en route) se reprend.
 *
 * @param {object} options
 * @param {{ collection(name: string): any }} options.db `Db` du pilote mongodb ou `mongoose.connection`.
 * @param {number} [options.leaseMs=10000] durée du bail ; le travail doit tenir dedans.
 * @param {number} [options.waitMs=5000]   attente maximale avant `LOCK_TIMEOUT`.
 */
function createMongoBookingStore({ db, prefix = 'booking_', leaseMs = 10000, waitMs = 5000 } = {}) {
  if (typeof db?.collection !== 'function') throw new TypeError('db.collection doit être une fonction.');
  const rdv = () => db.collection(`${prefix}bookings`);
  const verrous = () => db.collection(`${prefix}locks`);

  let index = null;
  const indexer = () => {
    index ||= Promise.resolve(rdv().createIndex({ resourceIds: 1, start: 1, end: 1 })).catch((erreur) => {
      index = null;
      throw erreur;
    });
    return index;
  };

  const versRdv = (d) => {
    if (!d) return null;
    const { _id, start, end, createdAt, updatedAt, cancelledAt, ...reste } = d;
    return {
      ...reste,
      id: _id,
      start: start.toISOString(),
      end: end.toISOString(),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      cancelledAt: cancelledAt ? cancelledAt.toISOString() : null
    };
  };
  const DATES = ['start', 'end', 'createdAt', 'updatedAt', 'cancelledAt'];
  const versDoc = (patch) => {
    const doc = { ...patch };
    for (const cle of DATES) if (doc[cle]) doc[cle] = new Date(doc[cle]);
    return doc;
  };

  const ops = {
    async listBookings(resourceId, from, to) {
      const docs = await rdv()
        .find({ resourceIds: String(resourceId), status: { $ne: 'cancelled' }, start: { $lt: new Date(to) }, end: { $gt: new Date(from) } })
        .sort({ start: 1 })
        .toArray();
      return docs.map(versRdv);
    },
    async getBooking(id) {
      return versRdv(await rdv().findOne({ _id: id }));
    }
  };

  async function prendre(id, detenteur) {
    const limite = Date.now() + waitMs;
    for (;;) {
      const maintenant = new Date();
      try {
        await verrous().insertOne({ _id: id, owner: detenteur, expiresAt: new Date(maintenant.getTime() + leaseMs) });
        return;
      } catch (erreur) {
        if (erreur?.code !== 11000) throw erreur;
      }
      const repris = await verrous().findOneAndUpdate(
        { _id: id, expiresAt: { $lt: maintenant } },
        { $set: { owner: detenteur, expiresAt: new Date(maintenant.getTime() + leaseMs) } }
      );
      // Pilote ≥ 6 : le document ; versions plus anciennes : { value }.
      if (repris && (repris.value !== undefined ? repris.value : repris)) return;
      if (Date.now() > limite) throw Object.assign(new Error(`Ressource occupée trop longtemps : ${id}`), { code: 'LOCK_TIMEOUT' });
      await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 20));
    }
  }

  return {
    ...ops,
    async transaction(resourceIds, travail) {
      await indexer();
      const detenteur = randomUUID();
      const pris = [];
      try {
        for (const id of ordonner(resourceIds)) {
          await prendre(id, detenteur);
          pris.push(id);
        }
        const ecritures = [];
        const resultat = await travail({
          ...ops,
          insert: async (b) => {
            const { id, ...reste } = b;
            ecritures.push(() => rdv().insertOne(versDoc({ _id: id, ...reste })));
          },
          update: async (id, patch) => {
            ecritures.push(() => rdv().updateOne({ _id: id }, { $set: versDoc(patch) }));
          }
        });
        for (const ecrire of ecritures) await ecrire();
        return resultat;
      } finally {
        await Promise.all(pris.map((id) => verrous().deleteOne({ _id: id, owner: detenteur })));
      }
    }
  };
}

module.exports = {
  assertBookingStore,
  createMemoryBookingStore,
  createPostgresBookingStore,
  createMongoBookingStore
};
