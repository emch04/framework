const express = require('express');
const { apiResponse, asyncHandler } = require('@astratra/core');
const { requireBodyFields } = require('../utils');

function createSettingsRoutes({ settingsStore, authorizeAdmin }) {
  const router = express.Router();

  router.use(authorizeAdmin);

  router.get('/', asyncHandler(async (req, res) => {
    const settings = await settingsStore.getAll();
    return apiResponse(res, 200, 'Settings list', settings);
  }));

  router.patch('/:key', asyncHandler(async (req, res) => {
    requireBodyFields(req.body || {}, ['value']);
    const value = await settingsStore.set(req.params.key, req.body.value);
    return apiResponse(res, 200, 'Setting updated', { key: req.params.key, value });
  }));

  return router;
}

module.exports = createSettingsRoutes;
