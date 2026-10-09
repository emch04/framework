'use strict';

class ConscienceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConscienceError';
    this.code = code;
  }
}

module.exports = { ConscienceError };
