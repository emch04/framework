/**
 * Stockage PostgreSQL. Il prend un pool compatible `pg` (le même que
 * @astratra/store-postgres) et ne charge aucun pilote lui-même.
 *
 * Le schéma se crée avec `ledgerPostgresMigrations(prefixe)`, un tableau
 * { id, up(client) } au format du lanceur de migrations de
 * @astratra/store-postgres (`createPostgresMigrationRunner`).
 *
 * Garanties :
 * - chaque transaction du moteur est une transaction SQL (BEGIN / COMMIT,
 *   ROLLBACK en cas d'erreur) : pas de numéro consommé sans écriture ;
 * - les transactions d'une même entité sont sérialisées par un verrou
 *   consultatif (pg_advisory_xact_lock), libéré au COMMIT ;
 * - une écriture validée ne peut plus être modifiée ni supprimée par ce
 *   code : toutes les mises à jour portent `WHERE status = 'draft'`, et le
 *   numéro est unique par entité (contrainte UNIQUE).
 */

function verifierPrefixe(prefixe) {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(prefixe)) throw new Error(`@astratra/ledger : préfixe de table invalide « ${prefixe} ».`);
  return prefixe;
}

/** Migrations du schéma, à passer à createPostgresMigrationRunner().run(). */
function ledgerPostgresMigrations(prefixe = 'ledger') {
  const p = verifierPrefixe(prefixe);
  return [
    {
      id: `${p}-001-schema`,
      async up(client) {
        await client.query(`CREATE TABLE ${p}_accounts (entity_id TEXT NOT NULL, code TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (entity_id, code))`);
        await client.query(`CREATE TABLE ${p}_partners (entity_id TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (entity_id, id))`);
        await client.query(`CREATE TABLE ${p}_journals (entity_id TEXT NOT NULL, code TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (entity_id, code))`);
        await client.query(`CREATE TABLE ${p}_fiscal_years (entity_id TEXT NOT NULL, code TEXT NOT NULL, start_date TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (entity_id, code))`);
        await client.query(`CREATE TABLE ${p}_entries (
          entity_id TEXT NOT NULL,
          id TEXT NOT NULL,
          created_seq SERIAL,
          journal TEXT NOT NULL,
          fiscal_year TEXT NOT NULL,
          status TEXT NOT NULL,
          entry_date TEXT NOT NULL,
          posted_number TEXT,
          reverses TEXT,
          data JSONB NOT NULL,
          PRIMARY KEY (entity_id, id),
          UNIQUE (entity_id, posted_number)
        )`);
        await client.query(`CREATE INDEX ${p}_entries_scope ON ${p}_entries (entity_id, fiscal_year, status, entry_date)`);
        await client.query(`CREATE TABLE ${p}_sequences (entity_id TEXT NOT NULL, journal TEXT NOT NULL, fiscal_year TEXT NOT NULL, last_number INTEGER NOT NULL, last_date TEXT, PRIMARY KEY (entity_id, journal, fiscal_year))`);
        await client.query(`CREATE TABLE ${p}_matchings (entity_id TEXT NOT NULL, code TEXT NOT NULL, account TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (entity_id, code))`);
        await client.query(`CREATE TABLE ${p}_matching_lines (entity_id TEXT NOT NULL, line_id TEXT NOT NULL, code TEXT NOT NULL, PRIMARY KEY (entity_id, line_id))`);
        await client.query(`CREATE TABLE ${p}_statement_lines (entity_id TEXT NOT NULL, id TEXT NOT NULL, account TEXT NOT NULL, line_date TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (entity_id, id))`);
      }
    }
  ];
}

function acces(requete, p, entite) {
  const un = async (sql, valeurs) => {
    const { rows } = await requete(sql, valeurs);
    return rows.length ? rows[0].data : null;
  };
  const plusieurs = async (sql, valeurs) => (await requete(sql, valeurs)).rows.map((r) => r.data);
  const json = (valeur) => JSON.stringify(valeur);

  return {
    getAccount: (code) => un(`SELECT data FROM ${p}_accounts WHERE entity_id = $1 AND code = $2`, [entite, code]),
    listAccounts: () => plusieurs(`SELECT data FROM ${p}_accounts WHERE entity_id = $1 ORDER BY code`, [entite]),
    async insertAccount(compte) {
      await requete(`INSERT INTO ${p}_accounts (entity_id, code, data) VALUES ($1, $2, $3)`, [entite, compte.code, json(compte)]);
    },

    getPartner: (id) => un(`SELECT data FROM ${p}_partners WHERE entity_id = $1 AND id = $2`, [entite, id]),
    listPartners: () => plusieurs(`SELECT data FROM ${p}_partners WHERE entity_id = $1 ORDER BY id`, [entite]),
    async insertPartner(tiers) {
      await requete(`INSERT INTO ${p}_partners (entity_id, id, data) VALUES ($1, $2, $3)`, [entite, tiers.id, json(tiers)]);
    },

    getJournal: (code) => un(`SELECT data FROM ${p}_journals WHERE entity_id = $1 AND code = $2`, [entite, code]),
    listJournals: () => plusieurs(`SELECT data FROM ${p}_journals WHERE entity_id = $1 ORDER BY code`, [entite]),
    async insertJournal(journal) {
      await requete(`INSERT INTO ${p}_journals (entity_id, code, data) VALUES ($1, $2, $3)`, [entite, journal.code, json(journal)]);
    },

    listFiscalYears: () => plusieurs(`SELECT data FROM ${p}_fiscal_years WHERE entity_id = $1 ORDER BY start_date`, [entite]),
    async insertFiscalYear(exercice) {
      await requete(`INSERT INTO ${p}_fiscal_years (entity_id, code, start_date, data) VALUES ($1, $2, $3, $4)`, [entite, exercice.code, exercice.start, json(exercice)]);
    },
    async updateFiscalYear(code, modification) {
      const actuel = await un(`SELECT data FROM ${p}_fiscal_years WHERE entity_id = $1 AND code = $2`, [entite, code]);
      if (!actuel) return false;
      await requete(`UPDATE ${p}_fiscal_years SET data = $3 WHERE entity_id = $1 AND code = $2`, [entite, code, json({ ...actuel, ...modification })]);
      return true;
    },

    async insertEntry(e) {
      await requete(
        `INSERT INTO ${p}_entries (entity_id, id, journal, fiscal_year, status, entry_date, posted_number, reverses, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [entite, e.id, e.journal, e.fiscalYear, e.status, e.date, e.number || null, e.reverses || null, json(e)]
      );
    },
    getEntry: (id) => un(`SELECT data FROM ${p}_entries WHERE entity_id = $1 AND id = $2`, [entite, id]),
    listEntries(filtre = {}) {
      const conditions = ['entity_id = $1'];
      const valeurs = [entite];
      const ajouter = (colonne, operateur, valeur) => {
        if (valeur === undefined || valeur === null || valeur === '') return;
        valeurs.push(valeur);
        conditions.push(`${colonne} ${operateur} $${valeurs.length}`);
      };
      ajouter('status', '=', filtre.status);
      ajouter('journal', '=', filtre.journal);
      ajouter('fiscal_year', '=', filtre.fiscalYear);
      ajouter('entry_date', '>=', filtre.from);
      ajouter('entry_date', '<=', filtre.to);
      ajouter('reverses', '=', filtre.reverses);
      return plusieurs(`SELECT data FROM ${p}_entries WHERE ${conditions.join(' AND ')} ORDER BY entry_date, created_seq`, valeurs);
    },
    async replaceDraft(id, e) {
      const { rows } = await requete(
        `UPDATE ${p}_entries SET journal = $3, fiscal_year = $4, entry_date = $5, data = $6
         WHERE entity_id = $1 AND id = $2 AND status = 'draft' RETURNING id`,
        [entite, id, e.journal, e.fiscalYear, e.date, json(e)]
      );
      return rows.length === 1;
    },
    async deleteDraft(id) {
      const { rows } = await requete(`DELETE FROM ${p}_entries WHERE entity_id = $1 AND id = $2 AND status = 'draft' RETURNING id`, [entite, id]);
      return rows.length === 1;
    },
    async markPosted(id, validation) {
      const actuelle = await un(`SELECT data FROM ${p}_entries WHERE entity_id = $1 AND id = $2 AND status = 'draft'`, [entite, id]);
      if (!actuelle) return false;
      const { rows } = await requete(
        `UPDATE ${p}_entries SET status = 'posted', posted_number = $3, data = $4
         WHERE entity_id = $1 AND id = $2 AND status = 'draft' RETURNING id`,
        [entite, id, validation.number, json({ ...actuelle, ...validation, status: 'posted' })]
      );
      return rows.length === 1;
    },

    async getSequence(journal, exercice) {
      const { rows } = await requete(
        `SELECT last_number, last_date FROM ${p}_sequences WHERE entity_id = $1 AND journal = $2 AND fiscal_year = $3 FOR UPDATE`,
        [entite, journal, exercice]
      );
      return rows.length ? { last: Number(rows[0].last_number), lastDate: rows[0].last_date } : null;
    },
    async setSequence(journal, exercice, sequence) {
      await requete(
        `INSERT INTO ${p}_sequences (entity_id, journal, fiscal_year, last_number, last_date) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (entity_id, journal, fiscal_year) DO UPDATE SET last_number = EXCLUDED.last_number, last_date = EXCLUDED.last_date`,
        [entite, journal, exercice, sequence.last, sequence.lastDate]
      );
    },

    async insertMatching(m) {
      await requete(`INSERT INTO ${p}_matchings (entity_id, code, account, data) VALUES ($1, $2, $3, $4)`, [entite, m.code, m.account, json(m)]);
      for (const idLigne of m.lineIds) {
        await requete(`INSERT INTO ${p}_matching_lines (entity_id, line_id, code) VALUES ($1, $2, $3)`, [entite, idLigne, m.code]);
      }
    },
    async deleteMatching(code) {
      await requete(`DELETE FROM ${p}_matching_lines WHERE entity_id = $1 AND code = $2`, [entite, code]);
      const { rows } = await requete(`DELETE FROM ${p}_matchings WHERE entity_id = $1 AND code = $2 RETURNING code`, [entite, code]);
      return rows.length === 1;
    },
    listMatchings(filtre = {}) {
      if (filtre.lineId) {
        return plusieurs(
          `SELECT m.data FROM ${p}_matchings m JOIN ${p}_matching_lines l ON l.entity_id = m.entity_id AND l.code = m.code
           WHERE m.entity_id = $1 AND l.line_id = $2`,
          [entite, filtre.lineId]
        );
      }
      if (filtre.account) return plusieurs(`SELECT data FROM ${p}_matchings WHERE entity_id = $1 AND account = $2 ORDER BY code`, [entite, filtre.account]);
      return plusieurs(`SELECT data FROM ${p}_matchings WHERE entity_id = $1 ORDER BY code`, [entite]);
    },

    async insertStatementLines(lignes) {
      for (const l of lignes) {
        await requete(`INSERT INTO ${p}_statement_lines (entity_id, id, account, line_date, data) VALUES ($1, $2, $3, $4, $5)`, [entite, l.id, l.account, l.date, json(l)]);
      }
    },
    listStatementLines(filtre = {}) {
      if (filtre.account) {
        return plusieurs(`SELECT data FROM ${p}_statement_lines WHERE entity_id = $1 AND account = $2 ORDER BY line_date, id`, [entite, filtre.account]);
      }
      return plusieurs(`SELECT data FROM ${p}_statement_lines WHERE entity_id = $1 ORDER BY line_date, id`, [entite]);
    },
    async updateStatementLine(id, modification) {
      const actuelle = await un(`SELECT data FROM ${p}_statement_lines WHERE entity_id = $1 AND id = $2`, [entite, id]);
      if (!actuelle) return false;
      await requete(`UPDATE ${p}_statement_lines SET data = $3 WHERE entity_id = $1 AND id = $2`, [entite, id, json({ ...actuelle, ...modification })]);
      return true;
    }
  };
}

/**
 * @param {object} options
 * @param {object} options.pool pool compatible `pg` (query, connect)
 * @param {string} [options.tablePrefix='ledger']
 */
function createPostgresLedgerStore({ pool, tablePrefix = 'ledger' } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new Error('createPostgresLedgerStore : options.pool (compatible pg) est requis.');
  }
  const p = verifierPrefixe(tablePrefix);
  return {
    kind: 'postgres',
    async transaction(entite, fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${p}:${entite}`]);
        const resultat = await fn(acces((sql, valeurs) => client.query(sql, valeurs), p, entite));
        await client.query('COMMIT');
        return resultat;
      } catch (erreur) {
        await client.query('ROLLBACK');
        throw erreur;
      } finally {
        client.release();
      }
    },
    read(entite, fn) {
      return fn(acces((sql, valeurs) => pool.query(sql, valeurs), p, entite));
    }
  };
}

module.exports = { createPostgresLedgerStore, ledgerPostgresMigrations };
