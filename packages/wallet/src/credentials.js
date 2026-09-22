const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/* Certificat intermédiaire public d'Apple (WWDR G4, valable jusqu'en 2030) :
   rien de secret, identique pour tous les émetteurs. Il voyage avec le package
   plutôt que d'être recopié par chaque application. */
const APPLE_WWDR_G4 = fs.readFileSync(path.join(__dirname, 'certificates', 'apple-wwdr-g4.pem'), 'utf8');

/**
 * Lit un certificat Pass Type ID. Il porte lui-même son identifiant (UID) et
 * l'équipe Apple (OU) : les en extraire évite deux champs à recopier, et deux
 * occasions de se tromper.
 * @returns {{passTypeIdentifier: string|null, teamIdentifier: string|null, expiresAt: string, x509: crypto.X509Certificate} | null}
 */
function readPassCertificate(pem) {
  try {
    const x509 = new crypto.X509Certificate(pem);
    const champ = (nom) => (x509.subject.split('\n').find((ligne) => ligne.startsWith(`${nom}=`)) || '').slice(nom.length + 1);
    return {
      x509,
      passTypeIdentifier: champ('UID') || null,
      teamIdentifier: champ('OU') || null,
      expiresAt: new Date(x509.validTo).toISOString()
    };
  } catch {
    return null;
  }
}

/**
 * Contrôle un certificat Apple et sa clé avant de les enregistrer : un couple
 * incohérent ne se verrait sinon qu'au premier client qui ajoute sa carte.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkAppleCredentials({ certificate, privateKey }, now = Date.now()) {
  if (!certificate || !privateKey) {
    return { ok: false, reason: 'Colle le certificat et la clé privée Apple Wallet.' };
  }
  const lu = readPassCertificate(certificate);
  if (!lu) return { ok: false, reason: 'Le certificat n’est pas lisible : colle le bloc complet, de BEGIN CERTIFICATE à END CERTIFICATE.' };
  if (!lu.passTypeIdentifier?.startsWith('pass.') || !lu.teamIdentifier) {
    return { ok: false, reason: 'Ce certificat n’est pas un certificat Pass Type ID Apple Wallet.' };
  }
  if (new Date(lu.expiresAt).getTime() <= now) return { ok: false, reason: 'Ce certificat Apple a expiré : génère-en un nouveau.' };
  let cle;
  try {
    cle = crypto.createPrivateKey(privateKey);
  } catch {
    return { ok: false, reason: 'La clé privée n’est pas lisible : colle le bloc complet, de BEGIN à END PRIVATE KEY.' };
  }
  if (!lu.x509.checkPrivateKey(cle)) return { ok: false, reason: 'La clé privée ne correspond pas à ce certificat.' };
  return { ok: true };
}

/** Le JSON d'un compte de service Google, ou null s'il n'en est pas un. */
function readGoogleServiceAccount(json) {
  try {
    const compte = typeof json === 'string' ? JSON.parse(json) : json;
    return compte?.type === 'service_account' && compte.client_email && compte.private_key ? compte : null;
  } catch {
    return null;
  }
}

/**
 * Un champ absent veut dire « ne touche pas à celui-là » ; les deux absents
 * sont refusés.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkGoogleCredentials({ issuerId, serviceAccount }) {
  if (issuerId !== undefined && !/^\d{10,25}$/.test(String(issuerId).trim())) {
    return { ok: false, reason: 'L’ID émetteur Google Wallet est un nombre (par exemple 3388000000000000000).' };
  }
  if (serviceAccount !== undefined && !readGoogleServiceAccount(serviceAccount)) {
    return { ok: false, reason: 'Colle le contenu complet du fichier JSON du compte de service Google.' };
  }
  if (issuerId === undefined && serviceAccount === undefined) {
    return { ok: false, reason: 'Renseigne l’ID émetteur et la clé du compte de service Google.' };
  }
  return { ok: true };
}

/* Un certificat PEM commence par « ----- », qu'un pare-feu applicatif prend,
   à raison en général, pour un commentaire SQL. Encoder en hexadécimal côté
   interface ([0-9a-f] seulement) fait traverser ces champs précis sans
   affaiblir le pare-feu pour le reste. Le contenu décodé doit toujours passer
   par checkAppleCredentials / checkGoogleCredentials avant d'être gardé. */
function toHexField(texte) {
  return Buffer.from(String(texte ?? ''), 'utf8').toString('hex');
}

/** Décode un champ hexadécimal ; '' si ce n'est pas de l'hexadécimal, undefined s'il est absent. */
function fromHexField(valeur) {
  if (valeur === undefined) return undefined;
  const texte = String(valeur);
  return /^(?:[0-9a-f]{2})+$/i.test(texte) ? Buffer.from(texte, 'hex').toString('utf8') : '';
}

module.exports = {
  APPLE_WWDR_G4,
  readPassCertificate,
  checkAppleCredentials,
  readGoogleServiceAccount,
  checkGoogleCredentials,
  toHexField,
  fromHexField
};
