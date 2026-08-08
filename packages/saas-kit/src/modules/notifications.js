const express = require('express');
const { apiResponse, asyncHandler } = require('@astratra/core');
const { requireBodyFields } = require('../utils');

function createNotificationsRoutes({ notify, authorizeAdmin }) {
  const router = express.Router();

  router.use(authorizeAdmin);

  router.post('/send', asyncHandler(async (req, res) => {
    requireBodyFields(req.body || {}, ['userId', 'title', 'message']);
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
