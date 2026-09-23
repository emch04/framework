const http2 = require('node:http2');
const { PKPass } = require('passkit-generator');
const { APPLE_WWDR_G4, readPassCertificate } = require('./credentials');

const APNS_PRODUCTION = 'https://api.push.apple.com';

/**
 * Fabrique de cartes Apple Wallet (storeCard par défaut), signées avec le
 * certificat Pass Type ID de l'émetteur.
 *
 * L'identifiant de carte et l'équipe se lisent dans le certificat. Le style
 * (couleurs, logo) est celui de l'émetteur ; le contenu (champs, bande, QR)
 * change d'une carte à l'autre.
 *
 * @param {object} options
 * @param {string} options.certificate   certificat Pass Type ID (PEM).
 * @param {string} options.privateKey    clé privée associée (PEM).
 * @param {string} [options.passphrase]
 * @param {string} [options.wwdr]        certificat intermédiaire ; WWDR G4 par défaut.
 * @param {string} options.webServiceURL base du service web de mise à jour (…/v1 ajouté par Apple).
 * @param {string} options.organizationName
 * @param {string} options.description
 * @param {Record<string, Buffer>} options.images  images communes : icon.png, icon@2x.png, logo.png…
 * @param {{foregroundColor?: string, backgroundColor?: string, labelColor?: string}} [options.colors]
 * @param {'storeCard'|'generic'|'coupon'|'eventTicket'} [options.type='storeCard']
 */
function createApplePasses({
  certificate, privateKey, passphrase, wwdr = APPLE_WWDR_G4, webServiceURL,
  organizationName, description, images = {}, colors = {}, type = 'storeCard', logoText
}) {
  const lu = readPassCertificate(certificate);
  if (!lu?.passTypeIdentifier || !lu.teamIdentifier) {
    throw new Error('Certificat Pass Type ID illisible ou incomplet.');
  }
  const { passTypeIdentifier, teamIdentifier } = lu;

  /**
   * @param {object} card
   * @param {string} card.serialNumber
   * @param {string} card.authenticationToken au moins 16 caractères (exigence Apple).
   * @param {Array<object>} [card.headerFields] … et primaryFields, secondaryFields, auxiliaryFields, backFields
   * @param {{message: string, altText?: string, format?: string}} [card.barcode]
   * @param {Record<string, Buffer>} [card.images] images propres à cette carte (strip.png…), prioritaires.
   * @param {boolean} [card.voided] carte annulée : Apple Wallet la grise et la
   *        déclare inutilisable. C'est la seule façon, côté émetteur, de
   *        retirer une carte déjà ajoutée : seul son porteur peut l'effacer.
   * @returns {Buffer} le .pkpass
   */
  function build(card) {
    const pass = new PKPass(
      { ...images, ...(card.images || {}) },
      { wwdr, signerCert: certificate, signerKey: privateKey, signerKeyPassphrase: passphrase },
      {
        formatVersion: 1,
        passTypeIdentifier,
        teamIdentifier,
        serialNumber: card.serialNumber,
        organizationName,
        description,
        ...(logoText ? { logoText } : {}),
        ...colors,
        webServiceURL,
        authenticationToken: card.authenticationToken,
        ...(card.voided ? { voided: true } : {})
      }
    );
    pass.type = type;
    for (const zone of ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields']) {
      for (const field of card[zone] || []) pass[zone].push(field);
    }
    if (card.barcode) {
      pass.setBarcodes({
        format: card.barcode.format || 'PKBarcodeFormatQR',
        message: card.barcode.message,
        messageEncoding: 'utf-8',
        ...(card.barcode.altText ? { altText: card.barcode.altText } : {})
      });
    }
    return pass.getAsBuffer();
  }

  return { passTypeIdentifier, teamIdentifier, expiresAt: lu.expiresAt, build };
}

/**
 * Prévient un appareil qu'une carte a changé : Apple Wallet revient alors
 * chercher la nouvelle version auprès du service web. La notification est
 * vide par conception (Apple l'exige).
 *
 * Rejette avec `error.status` : 400 et 410 veulent dire que le jeton est mort
 * et doit être oublié.
 */
function sendApplePassUpdate(pushToken, { certificate, privateKey, passphrase, passTypeIdentifier, connect = http2.connect, host = APNS_PRODUCTION }) {
  return new Promise((resolve, reject) => {
    const session = connect(host, { cert: certificate, key: privateKey, passphrase });
    session.once('error', reject);
    const requete = session.request({
      ':method': 'POST',
      ':path': `/3/device/${pushToken}`,
      'apns-topic': passTypeIdentifier
    });
    let statut;
    requete.on('response', (headers) => { statut = Number(headers[':status']); });
    requete.on('error', reject);
    requete.on('end', () => {
      session.close();
      if (statut >= 200 && statut < 300) resolve(statut);
      else {
        const error = new Error(`APNs a répondu ${statut || 'sans statut'}`);
        error.status = statut;
        reject(error);
      }
    });
    requete.end('{}');
  });
}

/**
 * Prévient tous les appareils qui portent une carte, et oublie les jetons que
 * Apple déclare morts. Rejette si au moins un envoi a échoué pour une autre
 * raison.
 */
async function notifyApplePass({ registrations, passTypeIdentifier, serialNumber, ...apns }) {
  const inscrits = await registrations.listForPass(passTypeIdentifier, serialNumber);
  const resultats = await Promise.allSettled(inscrits.map(async ({ pushToken }) => {
    try {
      await sendApplePassUpdate(pushToken, { ...apns, passTypeIdentifier });
    } catch (error) {
      if ([400, 410].includes(error.status)) {
        await registrations.forgetPushToken(pushToken);
        return;
      }
      throw error;
    }
  }));
  const echec = resultats.find((resultat) => resultat.status === 'rejected');
  if (echec) throw echec.reason;
  return inscrits.length;
}

module.exports = { createApplePasses, sendApplePassUpdate, notifyApplePass };
