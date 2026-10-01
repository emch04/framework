'use strict';

/**
 * Codes : UNREACHABLE, TIMEOUT, UNAUTHORIZED, UNSUPPORTED_FILE, FILE_TOO_LARGE,
 * CONVERSION_FAILED (le service a répondu « failure »), HTTP_ERROR, INVALID_RESPONSE.
 */
class ExtractionError extends Error {
  constructor(code, message, { status = null, details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ExtractionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

module.exports = { ExtractionError };
