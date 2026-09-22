const credentials = require('./credentials');
const { createApplePasses, sendApplePassUpdate, notifyApplePass } = require('./apple');
const { createAppleWebServiceRouter } = require('./appleWebService');
const { createGoogleWallet, signSaveJwt } = require('./google');
const { createMemoryRegistrationStore, createMongooseRegistrationStore } = require('./registrations');

module.exports = {
  ...credentials,
  createApplePasses,
  sendApplePassUpdate,
  notifyApplePass,
  createAppleWebServiceRouter,
  createGoogleWallet,
  signSaveJwt,
  createMemoryRegistrationStore,
  createMongooseRegistrationStore
};
