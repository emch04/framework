const crypto = require('node:crypto');
const { GoogleAuth } = require('google-auth-library');

const API_BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

/* Chaque type de carte Google a sa ressource REST et sa clé dans le JWT
   d'ajout. La fidélité est le cas courant ; les autres suivent le même
   chemin. */
const KINDS = {
  loyalty: { resource: 'loyalty', jwtKey: 'loyaltyObjects' },
  generic: { resource: 'generic', jwtKey: 'genericObjects' },
  offer: { resource: 'offer', jwtKey: 'offerObjects' },
  giftCard: { resource: 'giftCard', jwtKey: 'giftCardObjects' }
};

const base64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Signe le JWT « Ajouter à Google Wallet » (RS256, clé du compte de service).
 * @param {object} payload   par exemple { loyaltyObjects: [{ id, classId }] }.
 */
function signSaveJwt(payload, credentials, { now = new Date(), origins } = {}) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const corps = {
    iss: credentials.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(now.getTime() / 1000),
    ...(origins ? { origins } : {}),
    payload
  };
  const signe = `${base64urlJson(header)}.${base64urlJson(corps)}`;
  const signature = crypto.createSign('RSA-SHA256').update(signe).sign(credentials.private_key, 'base64url');
  return `${signe}.${signature}`;
}

/**
 * @param {object} options
 * @param {string} options.issuerId
 * @param {object} options.credentials   JSON du compte de service (client_email, private_key).
 * @param {'loyalty'|'generic'|'offer'|'giftCard'} [options.kind='loyalty']
 * @param {(options: object) => Promise<object>} [options.request]  remplace le client HTTP (tests).
 */
function createGoogleWallet({ issuerId, credentials, kind = 'loyalty', request }) {
  const type = KINDS[kind];
  if (!type) throw new Error(`Type de carte Google inconnu : ${kind}`);
  const auth = request ? null : new GoogleAuth({ credentials, scopes: [SCOPE] });
  const classesPretes = new Map();

  async function requete(options) {
    if (request) return request(options);
    const client = await auth.getClient();
    return client.request(options);
  }

  const idOf = (suffix) => `${issuerId}.${String(suffix).replace(/[^\w.-]/g, '_')}`;
  const url = (ressource, id) => `${API_BASE}/${type.resource}${ressource}${id ? `/${encodeURIComponent(id)}` : ''}`;

  /* Crée la ressource si Google répond 404, sinon la met à jour : une seule
     fonction pour le premier envoi et tous les suivants. */
  async function upsert(ressource, data) {
    try {
      await requete({ method: 'PATCH', url: url(ressource, data.id), data });
    } catch (error) {
      if (error?.response?.status !== 404) throw error;
      await requete({ method: 'POST', url: url(ressource), data });
    }
    return data.id;
  }

  /**
   * La classe (le modèle commun à toutes les cartes de l'émetteur), vérifiée
   * une fois par processus et par définition.
   * @param {object} definition  la classe Google, `id` compris (voir classId).
   */
  async function ensureClass(definition) {
    const cle = JSON.stringify(definition);
    if (!classesPretes.has(cle)) {
      const promesse = upsert('Class', { reviewStatus: 'UNDER_REVIEW', ...definition })
        .catch((error) => { classesPretes.delete(cle); throw error; });
      classesPretes.set(cle, promesse);
    }
    return classesPretes.get(cle);
  }

  /** Crée ou met à jour la carte d'un client ; Google la pousse sur ses appareils. */
  function upsertObject(object) {
    return upsert('Object', object);
  }

  /**
   * Carte retirée par l'émetteur : Google l'affiche comme expirée et la
   * range avec les cartes passées. Seul le champ `state` est envoyé, rien
   * n'est recréé. Renvoie false si la carte n'a jamais été créée chez Google
   * (personne ne l'avait ajoutée) : il n'y a alors rien à retirer.
   * @param {string} id  identifiant complet de la carte (voir objectId).
   * @param {'INACTIVE'|'EXPIRED'} [state='INACTIVE']
   */
  async function deactivateObject(id, state = 'INACTIVE') {
    if (!['INACTIVE', 'EXPIRED'].includes(state)) throw new Error(`État de retrait inconnu : ${state}`);
    try {
      await requete({ method: 'PATCH', url: url('Object', id), data: { state } });
      return true;
    } catch (error) {
      if (error?.response?.status === 404) return false;
      throw error;
    }
  }

  /** Le lien « Ajouter à Google Wallet » pour des cartes déjà créées. */
  function saveLink(objects, options) {
    const refs = objects.map(({ id, classId }) => ({ id, classId }));
    return `https://pay.google.com/gp/v/save/${signSaveJwt({ [type.jwtKey]: refs }, credentials, options)}`;
  }

  return { classId: idOf, objectId: idOf, ensureClass, upsertObject, deactivateObject, saveLink };
}

module.exports = { createGoogleWallet, signSaveJwt };
