const { validationResult } = require('express-validator');
const apiResponse = require('./apiResponse');

function validateMiddleware(validations = []) {
  return async function validateRequest(req, res, next) {
    for (const validation of validations) {
      await validation.run(req);
    }

    const result = validationResult(req);

    if (result.isEmpty()) {
      return next();
    }

    return apiResponse(res, 400, 'Validation failed', { errors: result.array() }, false);
  };
}

module.exports = validateMiddleware;
