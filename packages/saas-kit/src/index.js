const { createSaasApp } = require('./app');
const createMemorySettingsStore = require('./stores/memorySettingsStore');
const createMemoryUsersStore = require('./stores/memoryUsersStore');
const createMemoryPasswordResetStore = require('./stores/memoryPasswordResetStore');
const createMemoryDevicesStore = require('./stores/memoryDevicesStore');

module.exports = {
  createSaasApp,
  createMemorySettingsStore,
  createMemoryUsersStore,
  createMemoryPasswordResetStore,
  createMemoryDevicesStore
};
