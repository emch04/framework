/**
 * Persistance des documents collaboratifs.
 *
 * Un document Yjs se sauvegarde en entier sous forme d'« état » binaire
 * (`Y.encodeStateAsUpdate`) : c'est ce que le serveur écrit à chaque
 * enregistrement, et ce qu'il relit au chargement. Une version nommée est un
 * instantané du même type, figé, accompagné de ses métadonnées.
 *
 * Contrat attendu par `createCollabServer` (toutes les méthodes sont
 * asynchrones) :
 *
 *   load(documentName)                    → Uint8Array | null
 *   store(documentName, state, info)      → void
 *   saveVersion(documentName, version)    → void   (version.state = instantané)
 *   listVersions(documentName)            → métadonnées, la plus récente d'abord
 *   getVersion(documentName, versionId)   → version avec son `state`, ou null
 *
 * Trois implémentations : mémoire (tests, développement), PostgreSQL et
 * MongoDB. Les deux dernières reçoivent la connexion de l'application ; le
 * paquet ne dépend d'aucun pilote.
 */

const METHODES = ['load', 'store', 'saveVersion', 'listVersions', 'getVersion'];

function assertPersistence(persistence) {
  for (const methode of METHODES) {
    if (typeof persistence?.[methode] !== 'function') {
      throw new TypeError(`persistence.${methode} doit être une fonction.`);
    }
  }
  return persistence;
}

/** Ramène un binaire lu en base (Buffer, Binary BSON, ArrayBuffer…) à un Uint8Array. */
function versOctets(valeur) {
  if (valeur == null) return null;
  if (valeur instanceof Uint8Array) return new Uint8Array(valeur.buffer, valeur.byteOffset, valeur.byteLength);
  if (valeur instanceof ArrayBuffer) return new Uint8Array(valeur);
  // Binary BSON (pilote mongodb ≥ 6) : `buffer` est déjà un Uint8Array.
  if (valeur.buffer instanceof Uint8Array) return versOctets(valeur.buffer);
  if (typeof valeur.value === 'function') return versOctets(valeur.value());
  throw new TypeError('État binaire illisible.');
}

/** Métadonnées publiques d'une version : jamais l'instantané lui-même. */
function meta(version) {
  const reste = { ...version };
  delete reste.state;
  return reste;
}

function trierRecentes(versions) {
  return versions.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function createMemoryPersistence() {
  const documents = new Map();
  const versions = new Map();

  return {
    async load(documentName) {
      const etat = documents.get(documentName);
      return etat ? new Uint8Array(etat) : null;
    },
    async store(documentName, state) {
      documents.set(documentName, new Uint8Array(state));
    },
    async saveVersion(documentName, version) {
      const liste = versions.get(documentName) || [];
      liste.push({ ...version, state: new Uint8Array(version.state) });
      versions.set(documentName, liste);
    },
    async listVersions(documentName) {
      return trierRecentes((versions.get(documentName) || []).map(meta));
    },
    async getVersion(documentName, versionId) {
      const trouvee = (versions.get(documentName) || []).find((v) => v.id === versionId);
      return trouvee ? { ...trouvee, state: new Uint8Array(trouvee.state) } : null;
    }
  };
}

const IDENTIFIANT_SQL = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * PostgreSQL : deux tables créées au premier usage. L'état et les instantanés
 * vont dans des colonnes `bytea`.
 *
 * @param {{ query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }} options.pool
 *        un `Pool` (ou client) de `pg`, ou tout objet au même contrat.
 */
function createPostgresPersistence({ pool, documentsTable = 'collab_documents', versionsTable = 'collab_versions' } = {}) {
  if (typeof pool?.query !== 'function') throw new TypeError('pool.query doit être une fonction.');
  for (const table of [documentsTable, versionsTable]) {
    if (!IDENTIFIANT_SQL.test(table)) throw new TypeError(`Nom de table invalide : ${table}`);
  }

  let pret = null;
  function preparer() {
    pret ||= (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${documentsTable} (
        name TEXT PRIMARY KEY,
        state BYTEA NOT NULL,
        size INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS ${versionsTable} (
        id TEXT PRIMARY KEY,
        document_name TEXT NOT NULL,
        label TEXT,
        author TEXT,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        state BYTEA NOT NULL
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS ${versionsTable}_document_idx ON ${versionsTable} (document_name, created_at DESC)`);
    })().catch((erreur) => {
      pret = null;
      throw erreur;
    });
    return pret;
  }

  const ligneVersMeta = (ligne) => ({
    id: ligne.id,
    documentName: ligne.document_name,
    label: ligne.label,
    author: ligne.author,
    kind: ligne.kind,
    size: Number(ligne.size),
    createdAt: new Date(ligne.created_at).toISOString()
  });

  return {
    async load(documentName) {
      await preparer();
      const { rows } = await pool.query(`SELECT state FROM ${documentsTable} WHERE name = $1`, [documentName]);
      return rows.length ? versOctets(rows[0].state) : null;
    },
    async store(documentName, state, info = {}) {
      await preparer();
      await pool.query(
        `INSERT INTO ${documentsTable} (name, state, size, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET state = EXCLUDED.state, size = EXCLUDED.size, updated_at = EXCLUDED.updated_at`,
        [documentName, Buffer.from(state), state.byteLength, info.updatedAt || new Date().toISOString()]
      );
    },
    async saveVersion(documentName, version) {
      await preparer();
      await pool.query(
        `INSERT INTO ${versionsTable} (id, document_name, label, author, kind, size, created_at, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [version.id, documentName, version.label ?? null, version.author ?? null, version.kind, version.size, version.createdAt, Buffer.from(version.state)]
      );
    },
    async listVersions(documentName) {
      await preparer();
      const { rows } = await pool.query(
        `SELECT id, document_name, label, author, kind, size, created_at FROM ${versionsTable}
         WHERE document_name = $1 ORDER BY created_at DESC`,
        [documentName]
      );
      return rows.map(ligneVersMeta);
    },
    async getVersion(documentName, versionId) {
      await preparer();
      const { rows } = await pool.query(
        `SELECT * FROM ${versionsTable} WHERE document_name = $1 AND id = $2`,
        [documentName, versionId]
      );
      return rows.length ? { ...ligneVersMeta(rows[0]), state: versOctets(rows[0].state) } : null;
    }
  };
}

/**
 * MongoDB : deux collections. `db` est un `Db` du pilote `mongodb` ou une
 * connexion Mongoose (`mongoose.connection`) : les deux exposent
 * `collection(nom)`.
 */
function createMongoPersistence({ db, documentsCollection = 'collab_documents', versionsCollection = 'collab_versions' } = {}) {
  if (typeof db?.collection !== 'function') throw new TypeError('db.collection doit être une fonction.');
  const documents = () => db.collection(documentsCollection);
  const versions = () => db.collection(versionsCollection);

  let index = null;
  const indexer = () => {
    index ||= Promise.resolve(versions().createIndex({ documentName: 1, createdAt: -1 })).catch((erreur) => {
      index = null;
      throw erreur;
    });
    return index;
  };

  const docVersMeta = (doc) => ({
    id: doc._id,
    documentName: doc.documentName,
    label: doc.label ?? null,
    author: doc.author ?? null,
    kind: doc.kind,
    size: doc.size,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt)
  });

  return {
    async load(documentName) {
      const doc = await documents().findOne({ _id: documentName });
      return doc ? versOctets(doc.state) : null;
    },
    async store(documentName, state, info = {}) {
      await documents().updateOne(
        { _id: documentName },
        { $set: { state: Buffer.from(state), size: state.byteLength, updatedAt: new Date(info.updatedAt || Date.now()) } },
        { upsert: true }
      );
    },
    async saveVersion(documentName, version) {
      await indexer();
      await versions().insertOne({
        _id: version.id,
        documentName,
        label: version.label ?? null,
        author: version.author ?? null,
        kind: version.kind,
        size: version.size,
        createdAt: new Date(version.createdAt),
        state: Buffer.from(version.state)
      });
    },
    async listVersions(documentName) {
      const docs = await versions()
        .find({ documentName }, { projection: { state: 0 } })
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map(docVersMeta);
    },
    async getVersion(documentName, versionId) {
      const doc = await versions().findOne({ _id: versionId, documentName });
      return doc ? { ...docVersMeta(doc), state: versOctets(doc.state) } : null;
    }
  };
}

module.exports = {
  assertPersistence,
  createMemoryPersistence,
  createPostgresPersistence,
  createMongoPersistence
};
