const express = require('express');
const { body } = require('express-validator');
const { apiResponse, asyncHandler, validateMiddleware } = require('@astratra/core');

const sendNotificationValidation = [
  body('userId').trim().notEmpty().withMessage('userId is required'),
  body('title').trim().notEmpty().isLength({ max: 200 }).withMessage('title must be between 1 and 200 characters'),
  body('message').trim().notEmpty().isLength({ max: 5000 }).withMessage('message must be between 1 and 5000 characters')
];

function createNotificationsRoutes({ notify, authorizeAdmin }) {
  const router = express.Router();

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
