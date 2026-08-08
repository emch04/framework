const express = require('express');
const { body, param } = require('express-validator');
const { apiResponse, asyncHandler, validateMiddleware } = require('@astratra/core');

const updateSettingValidation = [
  param('key').trim().notEmpty().isLength({ max: 200 }).withMessage('key must be between 1 and 200 characters'),
  body('value').exists().withMessage('value is required')
];

function createSettingsRoutes({ settingsStore, authorizeAdmin }) {
  const router = express.Router();

  router.use(authorizeAdmin);

  router.get('/', asyncHandler(async (req, res) => {
    const settings = await settingsStore.getAll();
    return apiResponse(res, 200, 'Settings list', settings);
  }));

  router.patch('/:key', validateMiddleware(updateSettingValidation), asyncHandler(async (req, res) => {
    const value = await settingsStore.set(req.params.key, req.body.value);
    return apiResponse(res, 200, 'Setting updated', { key: req.params.key, value });
  }));

  return router;
}

module.exports = createSettingsRoutes;
