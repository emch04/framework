const express = require('express');
const { body, param } = require('express-validator');
const { apiResponse, AppError, asyncHandler, validateMiddleware } = require('@astratra/core');
const { sanitizeUser, toPagination } = require('../utils');

const createUserValidation = [
  body('email').isEmail().withMessage('email must be a valid email address'),
  body('role').optional().isString().trim().notEmpty().withMessage('role must not be empty when provided')
];

const userIdValidation = [
  param('id').notEmpty().withMessage('id is required')
];

function createUsersRoutes({ usersStore, authorizeAdmin }) {
  const router = express.Router();

  router.use(authorizeAdmin);

  router.get('/', asyncHandler(async (req, res) => {
    const pagination = toPagination(req.query);
    const users = await usersStore.list(pagination);
    return apiResponse(res, 200, 'Users list', {
      items: users.map(sanitizeUser),
      limit: pagination.limit,
      offset: pagination.offset
    });
  }));

  router.get('/:id', validateMiddleware(userIdValidation), asyncHandler(async (req, res) => {
    const user = await usersStore.findById(req.params.id);
    if (!user) {
      throw new AppError('User not found.', 404);
    }

    return apiResponse(res, 200, 'User found', sanitizeUser(user));
  }));

  router.post('/', validateMiddleware(createUserValidation), asyncHandler(async (req, res) => {
    const user = await usersStore.create(req.body);
    return apiResponse(res, 201, 'User created', sanitizeUser(user));
  }));

  router.patch('/:id', validateMiddleware(userIdValidation), asyncHandler(async (req, res) => {
    const user = await usersStore.update(req.params.id, req.body || {});
    if (!user) {
      throw new AppError('User not found.', 404);
    }

    return apiResponse(res, 200, 'User updated', sanitizeUser(user));
  }));

  return router;
}

module.exports = createUsersRoutes;
