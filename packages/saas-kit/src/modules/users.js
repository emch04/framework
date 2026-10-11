const express = require('express');
const { body, param } = require('express-validator');
const { apiResponse, AppError, asyncHandler, validateMiddleware } = require('@astratra/core');
const { sanitizeUser, toPagination } = require('../utils');

/**
 * The only fields an admin may write through these routes. Everything else in
 * the request body is dropped — never `id`, a password, a hash, a token or any
 * field the store happens to keep (mass assignment). Passwords change through
 * the auth routes (reset), never here.
 */
const DEFAULT_WRITABLE_USER_FIELDS = ['email', 'role', 'name'];
const NEVER_WRITABLE = new Set(['id', '_id', 'password', 'passwordHash', 'hash', 'salt', 'tokens', 'refreshToken', 'sessions']);

const createUserValidation = [
  body('email').isEmail().withMessage('email must be a valid email address'),
  body('role').optional().isString().trim().notEmpty().withMessage('role must not be empty when provided')
];

const updateUserValidation = [
  param('id').notEmpty().withMessage('id is required'),
  body('email').optional().isEmail().withMessage('email must be a valid email address'),
  body('role').optional().isString().trim().notEmpty().withMessage('role must not be empty when provided')
];

const userIdValidation = [
  param('id').notEmpty().withMessage('id is required')
];

function pickWritable(input, fields) {
  const source = input && typeof input === 'object' ? input : {};
  return fields.reduce((picked, field) => {
    if (!NEVER_WRITABLE.has(field) && Object.prototype.hasOwnProperty.call(source, field)) {
      picked[field] = source[field];
    }
    return picked;
  }, {});
}

function createUsersRoutes({ usersStore, authorizeAdmin, publicUserFields, adminRoles = ['owner', 'admin'], ownerRoles = ['owner'], writableUserFields = DEFAULT_WRITABLE_USER_FIELDS }) {
  const router = express.Router();

  router.use(authorizeAdmin);

  /**
   * Who may grant or change what. An admin manages ordinary accounts only:
   * granting an admin role (owner included), or touching another admin's
   * account, is for an owner. The caller's role is read from the store, not
   * from the token, so a demotion applies at once.
   */
  async function assertMayWrite(req, target, nextRole) {
    const caller = req.user && req.user.id ? await usersStore.findById(req.user.id) : null;
    const callerRole = caller ? caller.role : null;
    if (!callerRole || !adminRoles.includes(callerRole)) {
      throw new AppError('Forbidden.', 403);
    }
    if (ownerRoles.includes(callerRole)) return;
    if (nextRole !== undefined && adminRoles.includes(nextRole)) {
      throw new AppError('Only an owner can grant this role.', 403);
    }
    if (target && adminRoles.includes(target.role)) {
      const self = String(target.id) === String(caller.id);
      if (!self || (nextRole !== undefined && nextRole !== target.role)) {
        throw new AppError('Only an owner can change this account.', 403);
      }
    }
  }

  router.get('/', asyncHandler(async (req, res) => {
    const pagination = toPagination(req.query);
    const users = await usersStore.list(pagination);
    return apiResponse(res, 200, 'Users list', {
      items: users.map((user) => sanitizeUser(user, publicUserFields)),
      limit: pagination.limit,
      offset: pagination.offset
    });
  }));

  router.get('/:id', validateMiddleware(userIdValidation), asyncHandler(async (req, res) => {
    const user = await usersStore.findById(req.params.id);
    if (!user) {
      throw new AppError('User not found.', 404);
    }

    return apiResponse(res, 200, 'User found', sanitizeUser(user, publicUserFields));
  }));

  router.post('/', validateMiddleware(createUserValidation), asyncHandler(async (req, res) => {
    const data = pickWritable(req.body, writableUserFields);
    await assertMayWrite(req, null, data.role);
    const user = await usersStore.create(data);
    return apiResponse(res, 201, 'User created', sanitizeUser(user, publicUserFields));
  }));

  router.patch('/:id', validateMiddleware(updateUserValidation), asyncHandler(async (req, res) => {
    const target = await usersStore.findById(req.params.id);
    if (!target) {
      throw new AppError('User not found.', 404);
    }
    const patch = pickWritable(req.body, writableUserFields);
    await assertMayWrite(req, target, patch.role);
    const user = await usersStore.update(req.params.id, patch);
    if (!user) {
      throw new AppError('User not found.', 404);
    }

    return apiResponse(res, 200, 'User updated', sanitizeUser(user, publicUserFields));
  }));

  return router;
}

module.exports = createUsersRoutes;
module.exports.DEFAULT_WRITABLE_USER_FIELDS = DEFAULT_WRITABLE_USER_FIELDS;
