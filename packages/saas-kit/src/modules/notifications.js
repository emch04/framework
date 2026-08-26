const express = require('express');
const { body } = require('express-validator');
const { AppError, apiResponse, asyncHandler, validateMiddleware } = require('@astratra/core');

const sendNotificationValidation = [
  body('userId').trim().notEmpty().withMessage('userId is required'),
  body('title').trim().notEmpty().isLength({ max: 200 }).withMessage('title must be between 1 and 200 characters'),
  body('message').trim().notEmpty().isLength({ max: 5000 }).withMessage('message must be between 1 and 5000 characters')
];

const deviceValidation = [
  body('installationId').trim().notEmpty().withMessage('installationId is required'),
  body('pushToken').trim().notEmpty().withMessage('pushToken is required')
];

function createNotificationsRoutes({ notify, authorizeAdmin, devicesStore }) {
  const router = express.Router();

  /*
   * Devices come FIRST, before the admin guard below.
   *
   * A person registering their own phone is not an administrative act — it is
   * the most ordinary thing a mobile app does on launch. Behind
   * `authorizeAdmin` nobody but an owner could ever receive a notification.
   *
   * Every route here is scoped to req.user.id, never to the id in the URL: an
   * installation id is guessable, and without the check anyone could read or
   * delete somebody else's device.
   */
  if (devicesStore) {
    router.post('/devices', validateMiddleware(deviceValidation), asyncHandler(async (req, res) => {
      /* Keyed on the installation id, so a re-registration UPDATES the row.
         Keyed on the push token — which rotates — one phone would pile up
         dead rows, and every send would get slower and noisier. */
      const device = await devicesStore.upsert({
        installationId: String(req.body.installationId),
        pushToken: String(req.body.pushToken),
        platform: req.body.platform ? String(req.body.platform) : undefined,
        deviceName: req.body.deviceName ? String(req.body.deviceName) : undefined,
        userId: String(req.user.id),
        updatedAt: Date.now()
      });
      return apiResponse(res, 200, 'Device registered', {
        registered: true,
        enabled: device.enabled !== false
      });
    }));

    router.get('/devices', asyncHandler(async (req, res) => (
      apiResponse(res, 200, 'Registered devices', await devicesStore.listForUser(String(req.user.id)))
    )));

    router.get('/devices/:installationId', asyncHandler(async (req, res) => {
      const device = await devicesStore.find(req.params.installationId);
      /* Someone else's device reads as "not registered" rather than as
         "forbidden": a 403 would confirm the id exists. */
      if (!device || device.userId !== String(req.user.id)) {
        return apiResponse(res, 200, 'Device status', { registered: false, enabled: false });
      }
      return apiResponse(res, 200, 'Device status', { registered: true, enabled: device.enabled !== false });
    }));

    router.delete('/devices/:installationId', asyncHandler(async (req, res) => {
      const device = await devicesStore.find(req.params.installationId);
      if (!device || device.userId !== String(req.user.id)) {
        throw new AppError('Device not found.', 404);
      }
      await devicesStore.remove(req.params.installationId);
      return apiResponse(res, 200, 'Device removed', { removed: true });
    }));
  }

  router.use(authorizeAdmin);

  router.post('/send', validateMiddleware(sendNotificationValidation), asyncHandler(async (req, res) => {
    const notification = {
      title: req.body.title,
      message: req.body.message,
      channel: req.body.channel
    };
    const result = await notify(req.body.userId, notification);
    return apiResponse(res, 200, 'Notification sent', result || { sent: true });
  }));

  return router;
}

module.exports = createNotificationsRoutes;
