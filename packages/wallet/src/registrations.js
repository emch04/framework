/**
 * Qui porte quelle carte : Apple Wallet inscrit chaque appareil auprès du
 * service web, avec un jeton de notification. Le même contrat pour les deux
 * implémentations :
 *
 *   register({ deviceLibraryIdentifier, passTypeIdentifier, serialNumber, pushToken }) → true si nouvelle
 *   unregister({ deviceLibraryIdentifier, passTypeIdentifier, serialNumber })          → true si supprimée
 *   listForDevice(deviceLibraryIdentifier, passTypeIdentifier)                         → inscriptions
 *   listForPass(passTypeIdentifier, serialNumber)                                      → inscriptions
 *   forgetPushToken(pushToken)                                                         → jeton mort, oublié partout
 */

const memeInscription = (a, b) => a.deviceLibraryIdentifier === b.deviceLibraryIdentifier
  && a.passTypeIdentifier === b.passTypeIdentifier
  && a.serialNumber === b.serialNumber;

/** En mémoire : tests et démonstrations. */
function createMemoryRegistrationStore() {
  const rows = [];
  return {
    async register(inscription) {
      const existante = rows.find((row) => memeInscription(row, inscription));
      if (existante) {
        Object.assign(existante, { pushToken: inscription.pushToken, updatedAt: new Date() });
        return false;
      }
      rows.push({ ...inscription, createdAt: new Date(), updatedAt: new Date() });
      return true;
    },
    async unregister(inscription) {
      const index = rows.findIndex((row) => memeInscription(row, inscription));
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
    async listForDevice(deviceLibraryIdentifier, passTypeIdentifier) {
      return rows.filter((row) => row.deviceLibraryIdentifier === deviceLibraryIdentifier && row.passTypeIdentifier === passTypeIdentifier);
    },
    async listForPass(passTypeIdentifier, serialNumber) {
      return rows.filter((row) => row.passTypeIdentifier === passTypeIdentifier && row.serialNumber === serialNumber);
    },
    async forgetPushToken(pushToken) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].pushToken === pushToken) rows.splice(index, 1);
      }
    }
  };
}

/**
 * Sur une connexion Mongoose existante, sans dépendre de Mongoose : le schéma
 * se construit avec la classe portée par la connexion.
 * @param {object} connection   connexion Mongoose.
 * @param {string} [collection='apple_wallet_registrations']
 */
function createMongooseRegistrationStore(connection, collection = 'apple_wallet_registrations') {
  const schema = new connection.base.Schema({
    deviceLibraryIdentifier: { type: String, required: true },
    passTypeIdentifier: { type: String, required: true },
    serialNumber: { type: String, required: true },
    pushToken: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });
  schema.index({ deviceLibraryIdentifier: 1, passTypeIdentifier: 1, serialNumber: 1 }, { unique: true });
  schema.index({ passTypeIdentifier: 1, serialNumber: 1 });
  const Registration = connection.models.AstratraWalletRegistration
    || connection.model('AstratraWalletRegistration', schema, collection);
  let initialisation;
  const ready = () => { initialisation ||= Registration.init(); return initialisation; };

  return {
    async register({ deviceLibraryIdentifier, passTypeIdentifier, serialNumber, pushToken }) {
      await ready();
      const resultat = await Registration.updateOne(
        { deviceLibraryIdentifier, passTypeIdentifier, serialNumber },
        { $set: { pushToken, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      return resultat.upsertedCount > 0;
    },
    async unregister({ deviceLibraryIdentifier, passTypeIdentifier, serialNumber }) {
      const resultat = await Registration.deleteOne({ deviceLibraryIdentifier, passTypeIdentifier, serialNumber });
      return resultat.deletedCount > 0;
    },
    async listForDevice(deviceLibraryIdentifier, passTypeIdentifier) {
      return Registration.find({ deviceLibraryIdentifier, passTypeIdentifier }).lean();
    },
    async listForPass(passTypeIdentifier, serialNumber) {
      return Registration.find({ passTypeIdentifier, serialNumber }).lean();
    },
    async forgetPushToken(pushToken) {
      await Registration.deleteMany({ pushToken });
    }
  };
}

module.exports = { createMemoryRegistrationStore, createMongooseRegistrationStore };
