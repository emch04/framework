const { createSaasApp } = require('./app');
const createMemorySettingsStore = require('./stores/memorySettingsStore');
const createMemoryUsersStore = require('./stores/memoryUsersStore');

module.exports = {
  createSaasApp,
  createMemorySettingsStore,
  createMemoryUsersStore
};
