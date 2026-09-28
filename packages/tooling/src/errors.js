const { AppError } = require('@astratra/core');

/**
 * An error with a stable machine code (`PLAY_TOKEN_REFUSED`, `DEPLOY_DIRTY_TREE`...).
 * The message is for people and never carries a secret; `code` is for scripts and tests.
 */
class ToolingError extends AppError {
  constructor(code, message, statusCode = 500, details = undefined) {
    super(message, statusCode);
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

module.exports = {
  ToolingError
};
