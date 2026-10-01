/**
 * Serveur d'édition collaborative : Hocuspocus (protocole Yjs sur WebSocket)
 * branché sur l'authentification de l'application.
 *
 * Ce qu'ajoute ce module au serveur brut :
 *  - un seul crochet `authenticate` qui reçoit le jeton du client et rend le
 *    droit sur CE document : écriture, lecture seule, ou refus ;
 *  - une persistance injectable (mémoire, PostgreSQL, MongoDB ou la tienne) ;
 *  - un historique de versions : instantanés nommés et restauration, sans
 *    casser la session des personnes connectées ;
 *  - des limites de taille, par message et par document.
 */

const { randomUUID } = require('node:crypto');
const Y = require('yjs');
const { Server } = require('@hocuspocus/server');
const { assertPersistence, createMemoryPersistence } = require('./persistence');
const { DEFAULT_FIELD } = require('./convert');

const ACCES = ['write', 'read', 'none'];
const MIO = 1024 * 1024;

/** Erreur lue par Hocuspocus : `code` et `reason` partent au client à la fermeture. */
function erreurFermeture(code, reason) {
  return Object.assign(new Error(reason), { code, reason });
}

/**
 * La réponse de `authenticate` peut être courte (`'write'`, `'read'`, `false`)
 * ou détaillée (`{ access, user, context }`).
 */
function normaliserDecision(decision) {
  if (decision === true) return { access: 'write' };
  if (!decision) return { access: 'none' };
  if (typeof decision === 'string') return { access: decision };
  return decision;
}

/**
 * @param {object} options
 * @param {(demande: {token: string, documentName: string, headers: Headers, parameters: URLSearchParams}) =>
 *         Promise<'write'|'read'|'none'|boolean|null|{access: 'write'|'read'|'none', user?: unknown, context?: object}>} options.authenticate
 * @param {object} [options.persistence] voir `persistence.js` (mémoire par défaut).
 * @param {{maxDocumentBytes?: number, maxMessageBytes?: number}} [options.limits]
 * @param {string[]} [options.fields=['default']] fragments restaurés avec une version.
 */
function createCollabServer({
  authenticate,
  persistence = createMemoryPersistence(),
  limits = {},
  fields = [DEFAULT_FIELD],
  debounce = 2000,
  maxDebounce = 10000,
  port = 0,
  address,
  quiet = true,
  stopOnSignals = false,
  extensions = [],
  backupLabel = (version) => `Avant restauration : ${version.label ?? version.id}`
} = {}) {
  if (typeof authenticate !== 'function') throw new TypeError('authenticate doit être une fonction.');
  assertPersistence(persistence);
  const maxDocumentBytes = limits.maxDocumentBytes ?? 5 * MIO;
  const maxMessageBytes = limits.maxMessageBytes ?? MIO;
  if (!(maxMessageBytes > 0) || !(maxDocumentBytes > 0)) throw new TypeError('Les limites de taille doivent être positives.');

  /* Taille connue de chaque document chargé. Elle grossit de la taille de
     chaque mise à jour reçue, ce qui la surestime (Yjs fusionne) : quand
     l'estimation dépasse la limite, on la recalcule exactement avant de
     refuser quoi que ce soit. */
  const tailles = new Map();

  const server = new Server({
    port,
    address,
    quiet,
    stopOnSignals,
    debounce,
    maxDebounce,
    extensions,
    // Le serveur WebSocket coupe lui-même ce qui dépasse, avant tout décodage.
    websocketOptions: { maxPayload: maxMessageBytes + 1024 },

    async onAuthenticate({ token, documentName, requestHeaders, requestParameters, connectionConfig }) {
      let decision;
      try {
        decision = normaliserDecision(await authenticate({ token, documentName, headers: requestHeaders, parameters: requestParameters }));
      } catch {
        throw erreurFermeture(4403, 'permission-denied');
      }
      if (!ACCES.includes(decision.access)) throw new TypeError(`Accès inconnu : ${decision.access}`);
      if (decision.access === 'none') throw erreurFermeture(4403, 'permission-denied');
      // Lecture seule : Hocuspocus reçoit encore les messages mais n'applique
      // aucune modification venue de cette connexion.
      if (decision.access === 'read') connectionConfig.readOnly = true;
      return { ...(decision.context || {}), user: decision.user ?? null, access: decision.access };
    },

    async onLoadDocument({ document, documentName }) {
      const etat = await persistence.load(documentName);
      if (etat) Y.applyUpdate(document, etat);
      tailles.set(documentName, etat ? etat.byteLength : 0);
    },

    async onStoreDocument({ document, documentName }) {
      const etat = Y.encodeStateAsUpdate(document);
      tailles.set(documentName, etat.byteLength);
      await persistence.store(documentName, etat, { size: etat.byteLength, updatedAt: new Date().toISOString() });
    },

    async onChange({ documentName, update }) {
      tailles.set(documentName, (tailles.get(documentName) || 0) + update.byteLength);
    },

    async beforeHandleMessage({ update, document, documentName, connection }) {
      if (update.byteLength > maxMessageBytes) throw erreurFermeture(4413, 'message-too-large');
      if (connection?.readOnly) return;
      if ((tailles.get(documentName) || 0) + update.byteLength <= maxDocumentBytes) return;
      const exacte = Y.encodeStateAsUpdate(document).byteLength;
      tailles.set(documentName, exacte);
      if (exacte + update.byteLength > maxDocumentBytes) throw erreurFermeture(4413, 'document-too-large');
    },

    async afterUnloadDocument({ documentName }) {
      tailles.delete(documentName);
    }
  });
  const hocuspocus = server.hocuspocus;

  /** Ouvre le document côté serveur, en refusant un nom qui n'existe nulle part. */
  async function ouvrir(documentName, contexte) {
    if (!hocuspocus.documents.has(documentName) && !(await persistence.load(documentName))) {
      throw Object.assign(new Error(`Document introuvable : ${documentName}`), { code: 'DOCUMENT_NOT_FOUND' });
    }
    return hocuspocus.openDirectConnection(documentName, contexte);
  }

  async function createVersion(documentName, { label = null, author = null, kind = 'manual' } = {}) {
    const connexion = await ouvrir(documentName, { system: 'version', author });
    let etat;
    try {
      etat = Y.encodeStateAsUpdate(connexion.document);
    } finally {
      await connexion.disconnect();
    }
    const version = {
      id: randomUUID(),
      documentName,
      label,
      author,
      kind,
      size: etat.byteLength,
      createdAt: new Date().toISOString()
    };
    await persistence.saveVersion(documentName, { ...version, state: etat });
    return version;
  }

  /**
   * Remet le document dans l'état d'une version. Les personnes connectées
   * reçoivent la restauration comme une modification ordinaire : pas de
   * déconnexion, pas de rechargement. L'état courant est d'abord sauvegardé
   * en version « backup », pour que la restauration elle-même s'annule.
   */
  async function restoreVersion(documentName, versionId, { author = null } = {}) {
    const version = await persistence.getVersion(documentName, versionId);
    if (!version) throw Object.assign(new Error(`Version introuvable : ${versionId}`), { code: 'VERSION_NOT_FOUND' });
    const backup = await createVersion(documentName, { label: backupLabel(version), author, kind: 'backup' });

    const source = new Y.Doc();
    Y.applyUpdate(source, version.state);
    const connexion = await ouvrir(documentName, { system: 'restore', author });
    try {
      await connexion.transact((document) => {
        for (const champ of fields) {
          const cible = document.getXmlFragment(champ);
          const origine = source.getXmlFragment(champ);
          cible.delete(0, cible.length);
          cible.insert(0, origine.toArray().map((noeud) => noeud.clone()));
        }
      });
    } finally {
      await connexion.disconnect();
    }
    const restoredFrom = { ...version };
    delete restoredFrom.state;
    return { restoredFrom, backup };
  }

  /** État courant : celui en mémoire si le document est ouvert, sinon celui stocké. */
  async function getDocumentState(documentName) {
    const ouvert = hocuspocus.documents.get(documentName);
    return ouvert ? Y.encodeStateAsUpdate(ouvert) : persistence.load(documentName);
  }

  return {
    server,
    hocuspocus,
    limits: { maxDocumentBytes, maxMessageBytes },
    async listen(portEcoute) {
      await server.listen(portEcoute);
      const portReel = server.address.port;
      return { port: portReel, url: `ws://${address || '127.0.0.1'}:${portReel}` };
    },
    /** Enregistre les documents ouverts puis ferme les connexions. */
    async destroy() {
      await server.destroy();
    },
    createVersion,
    listVersions: (documentName) => persistence.listVersions(documentName),
    restoreVersion,
    getDocumentState
  };
}

module.exports = { createCollabServer };
