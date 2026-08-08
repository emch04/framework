const express = require('express');
const { apiResponse, AppError, asyncHandler } = require('@astratra/core');
const { requireBodyFields, sanitizeUser, toPagination } = require('../utils');

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

  router.get('/:id', asyncHandler(async (req, res) => {
    const user = await usersStore.findById(req.params.id);
    if (!user) {
      throw new AppError('User not found.', 404);
    }

    return apiResponse(res, 200, 'User found', sanitizeUser(user));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    requireBodyFields(req.body || {}, ['email']);
    const user = await usersStore.create(req.body);
    return apiResponse(res, 201, 'User created', sanitizeUser(user));
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const user = await usersStore.update(req.params.id, req.body || {});
    if (!user) {
      throw new AppError('User not found.', 404);
    }

    return apiResponse(res, 200, 'User updated', sanitizeUser(user));
  }));

  return router;
}

module.exports = createUsersRoutes;
